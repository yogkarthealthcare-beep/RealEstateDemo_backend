import express from "express";
import jwt from "jsonwebtoken";
import sql from "../db.js";
import { deleteFileFromStorage } from "../services/fileStorage.service.js";

const router = express.Router();

/**
 * Safely unlink physical files from storage folder or Cloudinary
 */
async function unlinkPhysicalFiles(fileList) {
  let count = 0;
  for (const item of fileList || []) {
    if (!item) continue;
    const url = typeof item === 'string' ? item : (item.url || item.file_path || item.file_url || '');
    const pubId = typeof item === 'object' ? (item.publicId || item.public_id || item.cloudinary_public_id || item.file_public_id || '') : '';
    if (url || pubId) {
      try {
        const deleted = await deleteFileFromStorage(url, pubId);
        if (deleted) count++;
      } catch (e) {
        console.warn('[MasterData] Error unlinking physical file:', url, pubId, e?.message);
      }
    }
  }
  return count;
}

const ok = (res, data, msg = "Success", status = 200) =>
  res.status(status).json({ success: true, message: msg, data });

const err = (res, msg = "Server error", status = 500) =>
  res.status(status).json({ success: false, message: msg });

// Admin Authentication Middleware
const authAdmin = (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) return err(res, "No admin token provided", 401);
  try {
    req.admin = jwt.verify(auth.split(" ")[1], process.env.JWT_ADMIN_SECRET || process.env.JWT_SECRET);
    return next();
  } catch {
    return err(res, "Invalid or expired admin token", 401);
  }
};

const requireAdminRole = (req, res, next) => {
  const role = req.admin?.role || req.admin?.user_type || "Admin";
  if (!["SuperAdmin", "Admin"].includes(role)) {
    return err(res, "Only Admin/SuperAdmin can access Master Data Management.", 403);
  }
  return next();
};

// Safe table name validator
const isValidTableName = (name) => {
  return typeof name === "string" && /^[a-zA-Z0-9_]{1,63}$/.test(name);
};

// Helper to categorize tables for intuitive UI tabs
const getTableCategory = (tableName) => {
  const t = tableName.toLowerCase();
  if (["users", "user_wallets", "associate_referral_links", "referral_registrations", "admin_users"].includes(t)) {
    return "Users & Auth";
  }
  if (t.includes("associate") || t.includes("team_member") || t.includes("mlm") || t.includes("rank") || t.includes("commission")) {
    return "Associates & Network";
  }
  if (t.includes("investor")) {
    return "Investors";
  }
  if (t.includes("booking") || t.includes("customer") || t.includes("receipt") || t.includes("invoice") || t.includes("emi") || t.includes("order")) {
    return "Customers & Bookings";
  }
  if (t.includes("plot") || t.includes("site")) {
    return "Properties & Sites";
  }
  if (t.includes("payment") || t.includes("gateway") || t.includes("wallet") || t.includes("withdrawal")) {
    return "Finance & Payments";
  }
  return "System & Master";
};

/**
 * GET /api/admin/master-data/tables
 * Lists all public database tables with row counts and column counts
 */
const getTablePrimaryKey = async (tableName, fallbackPk = null) => {
  if (fallbackPk && typeof fallbackPk === "string" && fallbackPk.trim()) {
    try {
      const [colExists] = await sql`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = ${tableName} AND column_name = ${fallbackPk.trim()}
        LIMIT 1
      `;
      if (colExists?.column_name) {
        return colExists.column_name;
      }
    } catch (_) {}
  }

  // 1. Direct PostgreSQL catalog lookup (fastest & most accurate: pg_index indisprimary)
  try {
    const [pgPk] = await sql`
      SELECT a.attname AS column_name
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = ${'public.' + tableName}::regclass
        AND i.indisprimary
      LIMIT 1
    `;
    if (pgPk?.column_name) return pgPk.column_name;
  } catch (_) {}

  // 2. Information schema table constraints
  try {
    const [infoPk] = await sql`
      SELECT kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name 
       AND tc.table_schema = kcu.table_schema 
       AND tc.table_name = kcu.table_name
      WHERE tc.constraint_type = 'PRIMARY KEY'
        AND tc.table_schema = 'public'
        AND tc.table_name = ${tableName}
      ORDER BY kcu.ordinal_position ASC
      LIMIT 1
    `;
    if (infoPk?.column_name) return infoPk.column_name;
  } catch (_) {}

  // 3. Fallback: Check columns for common primary key patterns or first column
  try {
    const cols = await sql`
      SELECT column_name, ordinal_position
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${tableName}
      ORDER BY ordinal_position ASC
    `;
    if (cols.length > 0) {
      const colNames = cols.map(c => c.column_name);
      if (colNames.includes("id")) return "id";
      const idCol = colNames.find(c => c.endsWith("_id"));
      if (idCol) return idCol;
      return colNames[0];
    }
  } catch (_) {}

  return "id";
};

router.get("/admin/master-data/tables", authAdmin, requireAdminRole, async (_req, res) => {
  try {
    const rawTables = await sql`
      SELECT 
        t.table_name,
        COALESCE(s.n_live_tup, 0) AS estimated_row_count,
        (
          SELECT COUNT(*) 
          FROM information_schema.columns c 
          WHERE c.table_schema = 'public' AND c.table_name = t.table_name
        ) AS column_count
      FROM information_schema.tables t
      LEFT JOIN pg_stat_user_tables s ON s.relname = t.table_name
      WHERE t.table_schema = 'public'
        AND t.table_type = 'BASE TABLE'
        AND t.table_name NOT LIKE 'knex_migrations%'
      ORDER BY t.table_name ASC
    `;

    const tables = rawTables.map((r) => ({
      tableName: r.table_name,
      rowCount: Number(r.estimated_row_count || 0),
      columnCount: Number(r.column_count || 0),
      category: getTableCategory(r.table_name)
    }));

    // Extract unique categories
    const categories = Array.from(new Set(tables.map((t) => t.category)));

    return ok(res, { tables, categories }, "Master tables fetched successfully");
  } catch (error) {
    console.error("[MasterData] Error fetching tables:", error);
    return err(res, "Failed to load database tables: " + error.message);
  }
});

/**
 * GET /api/admin/master-data/tables/:tableName
 * Fetches schema definition and paginated records for a selected table
 */
router.get("/admin/master-data/tables/:tableName", authAdmin, requireAdminRole, async (req, res) => {
  const { tableName } = req.params;
  if (!isValidTableName(tableName)) {
    return err(res, "Invalid table name specified", 400);
  }

  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(5, parseInt(req.query.limit) || 25));
  const offset = (page - 1) * limit;
  const search = req.query.search ? String(req.query.search).trim() : "";
  const sortBy = req.query.sortBy ? String(req.query.sortBy).trim() : null;
  const sortOrder = String(req.query.sortOrder || "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC";
  const userType = req.query.userType ? String(req.query.userType).trim().toLowerCase() : "";

  try {
    // 1. Check if table exists in public schema
    const [tableExists] = await sql`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_name = ${tableName}
      LIMIT 1
    `;
    if (!tableExists) {
      return err(res, `Table "${tableName}" does not exist`, 404);
    }

    // 2. Fetch columns definition
    const columns = await sql`
      SELECT 
        c.column_name, 
        c.data_type, 
        c.is_nullable, 
        c.column_default,
        c.character_maximum_length,
        CASE WHEN kcu.column_name IS NOT NULL THEN TRUE ELSE FALSE END AS is_primary_key
      FROM information_schema.columns c
      LEFT JOIN (
        SELECT k.column_name, k.table_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage k
          ON tc.constraint_name = k.constraint_name AND tc.table_schema = k.table_schema
        WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public'
      ) kcu ON kcu.table_name = c.table_name AND kcu.column_name = c.column_name
      WHERE c.table_schema = 'public' AND c.table_name = ${tableName}
      ORDER BY c.ordinal_position ASC
    `;

    const primaryKeyCol = columns.find((c) => c.is_primary_key)?.column_name || columns[0]?.column_name || "id";

    // 3. Prepare WHERE conditions (userType filter + search)
    const conditions = [];
    const queryParams = [];

    // Filter by userType if specified and table has user_type / user_role column
    if (userType) {
      const colNames = columns.map((c) => c.column_name.toLowerCase());
      const typeCol = colNames.includes("user_type") ? "user_type" : (colNames.includes("user_role") ? "user_role" : null);
      if (typeCol) {
        let pattern = `%${userType}%`;
        if (userType === "associate") pattern = "%assoc%";
        else if (userType === "team_member" || userType === "team member") pattern = "%team%";
        else if (userType === "customer") pattern = "%cust%";
        else if (userType === "investor") pattern = "%invest%";

        queryParams.push(pattern);
        conditions.push(`LOWER(CAST("${typeCol}" AS TEXT)) LIKE $${queryParams.length}`);
      }
    }

    // Filter by search across string/numeric columns
    if (search) {
      queryParams.push(`%${search}%`);
      const searchParamIdx = queryParams.length;
      const textColumns = columns
        .filter((c) => ["character varying", "text", "character", "integer", "bigint"].includes(c.data_type))
        .map((c) => `CAST("${c.column_name}" AS TEXT) ILIKE $${searchParamIdx}`);

      if (textColumns.length > 0) {
        conditions.push(`(${textColumns.join(" OR ")})`);
      }
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // 4. Determine sorting column
    let orderColumn = primaryKeyCol;
    if (sortBy && columns.some((c) => c.column_name === sortBy)) {
      orderColumn = sortBy;
    }

    // 5. Query total count
    const countQuery = `SELECT COUNT(*) AS total FROM "${tableName}" ${whereClause}`;
    const [countRes] = await sql.unsafe(countQuery, queryParams);
    const total = parseInt(countRes?.total || 0, 10);

    // 6. Query records - safely exclude raw binary bytea columns (file_data, payment_screenshot_data)
    // so master data loads instantly without transmitting megabytes of Buffer JSON
    const visibleColumns = columns.filter((c) => {
      const colName = (c.column_name || '').toLowerCase();
      const dataType = (c.data_type || '').toLowerCase();
      return colName !== 'file_data' && colName !== 'payment_screenshot_data' && dataType !== 'bytea';
    });

    const selectCols = (visibleColumns.length > 0 ? visibleColumns : columns).map((c) => `"${c.column_name}"`).join(', ');

    const recordsQuery = `
      SELECT ${selectCols} 
      FROM "${tableName}" 
      ${whereClause} 
      ORDER BY "${orderColumn}" ${sortOrder} 
      LIMIT ${limit} OFFSET ${offset}
    `;
    const records = await sql.unsafe(recordsQuery, queryParams);

    const totalPages = Math.ceil(total / limit) || 1;

    return ok(res, {
      tableName,
      primaryKey: primaryKeyCol,
      columns: visibleColumns.map((c) => ({
        name: c.column_name,
        type: c.data_type,
        nullable: c.is_nullable === "YES",
        isPk: c.is_primary_key,
        default: c.column_default
      })),
      records,
      pagination: {
        total,
        page,
        limit,
        totalPages
      }
    });
  } catch (error) {
    console.error(`[MasterData] Error querying table ${tableName}:`, error);
    return err(res, `Failed to load records for table ${tableName}: ` + error.message);
  }
});

/**
 * PUT /api/admin/master-data/tables/:tableName/:id
 * Modifies an existing row in the selected table
 */
router.put("/admin/master-data/tables/:tableName/:id", authAdmin, requireAdminRole, async (req, res) => {
  const { tableName, id } = req.params;
  const updateData = req.body?.data || req.body;

  if (!isValidTableName(tableName)) {
    return err(res, "Invalid table name", 400);
  }
  if (!id) {
    return err(res, "Primary key id required", 400);
  }
  if (!updateData || typeof updateData !== "object" || Object.keys(updateData).length === 0) {
    return err(res, "No update data provided", 400);
  }

  try {
    // 1. Get primary key column
    const clientPk = req.query.pk || req.body?.pk || null;
    const primaryKey = await getTablePrimaryKey(tableName, clientPk);

    // 2. Fetch all valid columns for this table
    const columns = await sql`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_schema = 'public' AND table_name = ${tableName}
    `;
    const validColMap = new Map(columns.map((c) => [c.column_name, c.data_type]));

    // 3. Build parameterized UPDATE
    const setClauses = [];
    const values = [];
    let paramIndex = 1;

    for (const [key, rawVal] of Object.entries(updateData)) {
      if (key === primaryKey) continue; // Do not mutate primary key
      if (key.toLowerCase().replace(/[\s_-]/g, "") === "updatedat") continue; // Handled explicitly below to avoid duplicate assignments // Handled explicitly below to avoid duplicate assignments
      if (!validColMap.has(key)) continue; // Ignore non-existent columns

      let val = rawVal;
      // Convert empty strings to null for nullable integer/numeric/date columns
      const type = validColMap.get(key);
      if (val === "" && (type.includes("int") || type.includes("numeric") || type.includes("timestamp") || type.includes("date") || type.includes("bool"))) {
        val = null;
      }

      setClauses.push(`"${key}" = $${paramIndex}`);
      values.push(val);
      paramIndex++;
    }

    if (setClauses.length === 0) {
      return err(res, "No valid columns to update", 400);
    }

    // Add updated_at if column exists and not already provided
    if (validColMap.has("updated_at") && !setClauses.some(s => s.startsWith('"updated_at"'))) {
      setClauses.push(`"updated_at" = NOW()`);
    }

    values.push(id);
    const updateSql = `
      UPDATE "${tableName}"
      SET ${setClauses.join(", ")}
      WHERE "${primaryKey}" = $${paramIndex}
      RETURNING *
    `;

    const [updatedRow] = await sql.unsafe(updateSql, values);
    if (!updatedRow) {
      return err(res, `Record with ${primaryKey}=${id} not found in ${tableName}`, 404);
    }

    return ok(res, updatedRow, `Record #${id} in table "${tableName}" updated successfully`);
  } catch (error) {
    console.error(`[MasterData] Error updating ${tableName} row ${id}:`, error);
    return err(res, `Failed to update record: ` + error.message);
  }
});

/**
 * Helper: Delete bookings and all their child records, and reset plots to 'Vacant' (Green)
 */
async function deleteBookingsAndResetPlots(tx, bookingIds, filesToUnlinkCollector = []) {
  const bIds = (bookingIds || []).map(Number).filter(id => id > 0);
  if (bIds.length === 0) return { deletedBookings: 0, resetPlots: 0 };

  // 1. Get plot_ids for these bookings before deleting
  const bookingRows = await tx`
    SELECT booking_id, plot_id FROM bookings WHERE booking_id IN ${tx(bIds)}
  `.catch(() => []);
  const plotIds = [...new Set(bookingRows.map(b => Number(b.plot_id)).filter(id => id > 0))];

  // Collect physical files from booking_payment_proofs before deletion
  try {
    const bProofs = await tx`
      SELECT file_url, file_public_id, payment_proof_url 
      FROM booking_payment_proofs 
      WHERE booking_id IN ${tx(bIds)}
    `;
    for (const p of bProofs) {
      if (p.file_url) filesToUnlinkCollector.push({ url: p.file_url, publicId: p.file_public_id });
      if (p.payment_proof_url) filesToUnlinkCollector.push(p.payment_proof_url);
    }
  } catch {}

  // Collect physical files from emi_payment_proofs before deletion
  try {
    const emiProofs = await tx`
      SELECT payment_proof_url, file_public_id 
      FROM emi_payment_proofs 
      WHERE booking_id IN ${tx(bIds)} 
         OR emi_schedule_id IN (
           SELECT emi_schedule_id FROM emi_schedules WHERE booking_id IN ${tx(bIds)}
         )
    `;
    for (const p of emiProofs) {
      if (p.payment_proof_url) filesToUnlinkCollector.push({ url: p.payment_proof_url, publicId: p.file_public_id });
    }
  } catch {}

  // 2. Delete all child records dependent on these bookings
  await tx`DELETE FROM booking_payment_proofs WHERE booking_id IN ${tx(bIds)}`.catch(() => {});
  await tx`DELETE FROM booking_payment_records WHERE booking_id IN ${tx(bIds)}`.catch(() => {});
  await tx`DELETE FROM emi_payment_proofs WHERE booking_id IN ${tx(bIds)}`.catch(() => {});
  await tx`
    DELETE FROM emi_payment_proofs WHERE emi_schedule_id IN (
      SELECT emi_schedule_id FROM emi_schedules WHERE booking_id IN ${tx(bIds)}
    )
  `.catch(() => {});
  await tx`DELETE FROM emi_schedules WHERE booking_id IN ${tx(bIds)}`.catch(() => {});

  // Invoices & Logs
  await tx`
    DELETE FROM invoice_audit_log WHERE invoice_id IN (
      SELECT invoice_id FROM invoices WHERE booking_id IN ${tx(bIds)}
    )
  `.catch(() => {});
  await tx`DELETE FROM booking_invoices WHERE booking_id IN ${tx(bIds)}`.catch(() => {});
  await tx`DELETE FROM invoices WHERE booking_id IN ${tx(bIds)}`.catch(() => {});

  // Commissions & Settlements
  await tx`DELETE FROM commission_transactions WHERE related_booking_id IN ${tx(bIds)}`.catch(() => {});
  await tx`DELETE FROM commission_source_events WHERE booking_id IN ${tx(bIds)}`.catch(() => {});
  await tx`DELETE FROM plot_order_settlements WHERE booking_id IN ${tx(bIds)}`.catch(() => {});

  // Appointments, Buybacks, Registries, Locks & History
  await tx`DELETE FROM buyback_applications WHERE booking_id IN ${tx(bIds)}`.catch(() => {});
  await tx`DELETE FROM registry_records WHERE booking_id IN ${tx(bIds)}`.catch(() => {});
  await tx`DELETE FROM booking_appointments WHERE booking_id IN ${tx(bIds)}`.catch(() => {});
  await tx`DELETE FROM plot_booking_history WHERE booking_id IN ${tx(bIds)}`.catch(() => {});
  await tx`DELETE FROM plot_booking_locks WHERE booking_id IN ${tx(bIds)}`.catch(() => {});

  // Delete from bookings table
  const delRes = await tx`
    DELETE FROM bookings WHERE booking_id IN ${tx(bIds)} RETURNING booking_id
  `.catch(() => []);

  // 3. Reset plots back to 'Vacant' (Turns Green on the layout map for fresh bookings!)
  let resetPlotsCount = 0;
  if (plotIds.length > 0) {
    const resetRows = await tx`
      UPDATE plots
      SET plot_status = 'Vacant',
          updated_at = NOW()
      WHERE plot_id IN ${tx(plotIds)}
        AND plot_id NOT IN (
          SELECT plot_id FROM bookings WHERE booking_status IN ('Confirmed', 'Approved', 'Under Process')
        )
      RETURNING plot_id
    `.catch(() => []);
    resetPlotsCount = resetRows.length;
  }

  return { deletedBookings: delRes.length, resetPlots: resetPlotsCount };
}

/**
 * Helper: Delete all child records for a set of user IDs (KYC, Wallets, Nominees, MLM tree, etc.)
 */
async function deleteUserChildRecords(tx, userIds, filesToUnlinkCollector = []) {
  const uIds = (userIds || []).map(Number).filter(id => id > 0);
  if (uIds.length === 0) return;

  // Collect KYC files from customer_enrollment_submissions
  try {
    const kycFiles = await tx`
      SELECT aadhar_front_url, aadhar_back_url, pan_card_url, applicant_photo_url, signature_url 
      FROM customer_enrollment_submissions 
      WHERE user_id IN ${tx(uIds)}
    `;
    for (const f of kycFiles) {
      if (f.aadhar_front_url) filesToUnlinkCollector.push(f.aadhar_front_url);
      if (f.aadhar_back_url) filesToUnlinkCollector.push(f.aadhar_back_url);
      if (f.pan_card_url) filesToUnlinkCollector.push(f.pan_card_url);
      if (f.applicant_photo_url) filesToUnlinkCollector.push(f.applicant_photo_url);
      if (f.signature_url) filesToUnlinkCollector.push(f.signature_url);
    }
  } catch {}

  // Collect files from user_documents
  try {
    const uDocs = await tx`
      SELECT file_url, file_public_id 
      FROM user_documents 
      WHERE user_id IN ${tx(uIds)}
    `;
    for (const d of uDocs) {
      if (d.file_url) filesToUnlinkCollector.push({ url: d.file_url, publicId: d.file_public_id });
    }
  } catch {}

  // Collect files from team_members
  try {
    const tmFiles = await tx`
      SELECT photo_url, aadhar_front_url, aadhar_back_url, pan_card_url, signature_url 
      FROM team_members 
      WHERE user_id IN ${tx(uIds)}
    `;
    for (const f of tmFiles) {
      if (f.photo_url) filesToUnlinkCollector.push(f.photo_url);
      if (f.aadhar_front_url) filesToUnlinkCollector.push(f.aadhar_front_url);
      if (f.aadhar_back_url) filesToUnlinkCollector.push(f.aadhar_back_url);
      if (f.pan_card_url) filesToUnlinkCollector.push(f.pan_card_url);
      if (f.signature_url) filesToUnlinkCollector.push(f.signature_url);
    }
  } catch {}

  // Collect files from investor_documents and investor_deposits
  try {
    const invDocs = await tx`
      SELECT file_url, file_public_id 
      FROM investor_documents 
      WHERE investor_id IN ${tx(uIds)}
    `;
    for (const d of invDocs) {
      if (d.file_url) filesToUnlinkCollector.push({ url: d.file_url, publicId: d.file_public_id });
    }
  } catch {}

  try {
    const invDeposits = await tx`
      SELECT payment_screenshot_url 
      FROM investor_deposits 
      WHERE investor_id IN ${tx(uIds)}
    `;
    for (const d of invDeposits) {
      if (d.payment_screenshot_url) filesToUnlinkCollector.push(d.payment_screenshot_url);
    }
  } catch {}

  // Customer enrollment submissions & nominees
  await tx`
    DELETE FROM customer_nominees WHERE submission_id IN (
      SELECT id FROM customer_enrollment_submissions WHERE user_id IN ${tx(uIds)}
    )
  `.catch(() => {});
  await tx`DELETE FROM customer_enrollment_submissions WHERE user_id IN ${tx(uIds)}`.catch(() => {});

  // Profile & Documents
  await tx`DELETE FROM user_documents WHERE user_id IN ${tx(uIds)}`.catch(() => {});
  await tx`DELETE FROM user_addresses WHERE user_id IN ${tx(uIds)}`.catch(() => {});
  await tx`DELETE FROM user_bank_details WHERE user_id IN ${tx(uIds)}`.catch(() => {});
  await tx`DELETE FROM user_nominees WHERE user_id IN ${tx(uIds)}`.catch(() => {});
  await tx`DELETE FROM user_kyc_profiles WHERE user_id IN ${tx(uIds)}`.catch(() => {});

  // Wallets & Transactions
  await tx`DELETE FROM wallet_transactions WHERE user_id IN ${tx(uIds)}`.catch(() => {});
  await tx`DELETE FROM wallet_audit_logs WHERE user_id IN ${tx(uIds)}`.catch(() => {});
  await tx`DELETE FROM user_wallets WHERE user_id IN ${tx(uIds)}`.catch(() => {});

  // Payment transactions, complaints & leads
  await tx`DELETE FROM payment_transactions WHERE user_id IN ${tx(uIds)}`.catch(() => {});
  await tx`DELETE FROM missing_payment_complaints WHERE user_id IN ${tx(uIds)}`.catch(() => {});
  await tx`DELETE FROM book_plot_leads WHERE user_id IN ${tx(uIds)}`.catch(() => {});
  await tx`DELETE FROM inquiries WHERE user_id IN ${tx(uIds)}`.catch(() => {});

  // Associate & Team Member trackers, ranks, links, and payouts
  await tx`DELETE FROM commission_transactions WHERE associate_user_id IN ${tx(uIds)} OR seller_user_id IN ${tx(uIds)}`.catch(() => {});
  await tx`DELETE FROM associate_sales_tracker WHERE associate_user_id IN ${tx(uIds)}`.catch(() => {});
  await tx`DELETE FROM associate_rank_history WHERE associate_user_id IN ${tx(uIds)}`.catch(() => {});
  await tx`DELETE FROM associate_status_history WHERE associate_user_id IN ${tx(uIds)}`.catch(() => {});
  await tx`DELETE FROM associate_referral_links WHERE associate_user_id IN ${tx(uIds)}`.catch(() => {});
  await tx`DELETE FROM referral_clicks WHERE associate_user_id IN ${tx(uIds)}`.catch(() => {});
  await tx`DELETE FROM associate_payout_requests WHERE associate_user_id IN ${tx(uIds)}`.catch(() => {});
  await tx`DELETE FROM withdrawal_requests WHERE user_id IN ${tx(uIds)}`.catch(() => {});

  // Referrals
  await tx`UPDATE referral_registrations SET sponsor_user_id = 1 WHERE sponsor_user_id IN ${tx(uIds)} AND (referred_user_id IS NULL OR referred_user_id NOT IN ${tx(uIds)})`.catch(() => {});
  await tx`DELETE FROM referral_registrations WHERE referred_user_id IN ${tx(uIds)}`.catch(() => {});

  // MLM Tree
  await tx`UPDATE mlm_network SET sponsor_user_id = 1 WHERE sponsor_user_id IN ${tx(uIds)} AND associate_user_id NOT IN ${tx(uIds)}`.catch(() => {});
  await tx`DELETE FROM mlm_network WHERE associate_user_id IN ${tx(uIds)}`.catch(() => {});
  await tx`DELETE FROM mlm_tree_closure WHERE ancestor_user_id IN ${tx(uIds)} OR descendant_user_id IN ${tx(uIds)}`.catch(() => {});

  // Logs & Tokens
  await tx`DELETE FROM user_device_tokens WHERE user_id IN ${tx(uIds)}`.catch(() => {});
  await tx`DELETE FROM notification_queue WHERE user_id IN ${tx(uIds)}`.catch(() => {});
  await tx`DELETE FROM notification_log WHERE user_id IN ${tx(uIds)}`.catch(() => {});
  await tx`DELETE FROM whatsapp_message_logs WHERE user_id IN ${tx(uIds)}`.catch(() => {});
  await tx`DELETE FROM email_otp_log WHERE user_id IN ${tx(uIds)}`.catch(() => {});
  await tx`DELETE FROM otp_history WHERE user_id IN ${tx(uIds)}`.catch(() => {});
  await tx`DELETE FROM otp_log WHERE user_id IN ${tx(uIds)}`.catch(() => {});
  await tx`DELETE FROM otp_master WHERE user_id IN ${tx(uIds)}`.catch(() => {});
  await tx`DELETE FROM two_factor_otp_logs WHERE user_id IN ${tx(uIds)}`.catch(() => {});
}

/**
 * DELETE /api/admin/master-data/tables/:tableName/:id
 * Systematic Relational Deletion & Plot Rollback Engine:
 * - Deleting a Customer: Rolls back all customer bookings, removes invoices/EMIs, resets plots to 'Vacant' (Green).
 * - Deleting a Team Member: Removes attributed customer bookings, resets plots to 'Vacant', deletes member & files.
 * - Deleting an Associate: Strict protection for Suraj Kumar Verma (MMR00001); rolls back downline bookings & resets plots.
 * - Deleting a Booking: Rolls back payments/invoices and resets plot to 'Vacant' (Green).
 */
router.delete("/admin/master-data/tables/:tableName/:id", authAdmin, requireAdminRole, async (req, res) => {
  const { tableName, id } = req.params;
  const cascade = req.query.cascade === "true" || req.body?.cascade === true;

  if (!isValidTableName(tableName)) {
    return err(res, "Invalid table name", 400);
  }
  if (!id) {
    return err(res, "Record ID is required", 400);
  }

  try {
    const clientPk = req.query.pk || req.body?.pk || null;
    const primaryKey = await getTablePrimaryKey(tableName, clientPk);

    // ─────────────────────────────────────────────────────────────
    // SCENARIO 1: DELETING FROM 'users' (Customer, Team Member, or Associate)
    // ─────────────────────────────────────────────────────────────
    if (tableName.toLowerCase() === 'users') {
      const userId = Number(id);
      const [targetUser] = await sql`
        SELECT user_id, user_type, member_id, full_name, mobile_no, email
        FROM users
        WHERE user_id = ${userId}
        LIMIT 1
      `;

      if (!targetUser) {
        return err(res, `User #${id} not found in database`, 404);
      }

      // 🛡️ STRICT PROTECTION FOR SURAJ KUMAR VERMA (MMR00001)
      const isSuraj = (
        targetUser.user_type === 'Associate' && (
          String(targetUser.full_name || '').toLowerCase().includes('suraj') ||
          String(targetUser.member_id || '').toUpperCase() === 'MMR00001' ||
          String(targetUser.member_id || '').toUpperCase() === 'MMR-ASC-0001' ||
          userId === 1
        )
      );

      if (isSuraj) {
        return err(
          res,
          "सुरक्षित रूट एसोसिएट: 'सूरज कुमार वर्मा (MMR00001)' पूरे नेटवर्क का मुख्य रूट एसोसिएट है। इसे सिस्टम से डिलीट नहीं किया जा सकता!",
          403
        );
      }

      // Execute entire deletion inside a single ACID database transaction
      const filesToUnlink = [];
      const result = await sql.begin(async (tx) => {
        let deletedBookingsCount = 0;
        let resetPlotsCount = 0;
        let extraSummary = '';

        if (targetUser.user_type === 'Customer') {
          // 1. Find all customer bookings
          const custBookings = await tx`SELECT booking_id FROM bookings WHERE user_id = ${userId}`;
          const bIds = custBookings.map(b => b.booking_id);

          const { deletedBookings, resetPlots } = await deleteBookingsAndResetPlots(tx, bIds, filesToUnlink);
          deletedBookingsCount = deletedBookings;
          resetPlotsCount = resetPlots;

          // 2. Clean customer profile & KYC
          await deleteUserChildRecords(tx, [userId], filesToUnlink);

          // 3. Delete user row
          await tx`DELETE FROM users WHERE user_id = ${userId}`;
          extraSummary = `Customer "${targetUser.full_name}" (#${userId}) deleted. ${deletedBookings} booking(s) rolled back, and ${resetPlots} plot(s) reset to Green ('Vacant') for fresh booking.`;

        } else if (targetUser.user_type === 'Team Member') {
          // 1. Find customers registered by / attributed to this Team Member
          const downlineCusts = await tx`
            SELECT user_id FROM users
            WHERE (sponsor_user_id = ${userId} OR referred_by_user_id = ${userId})
              AND user_type = 'Customer'
          `;
          const custUserIds = downlineCusts.map(c => c.user_id);

          // 2. Find all bookings (direct sales by TM, customer bookings, self-purchases)
          const allUserIds = [userId, ...custUserIds];
          const tmBookings = await tx`
            SELECT booking_id FROM bookings
            WHERE user_id IN ${tx(allUserIds)}
               OR sold_by_user_id = ${userId}
               OR booked_by_user_id = ${userId}
          `;
          const bIds = tmBookings.map(b => b.booking_id);

          const { deletedBookings, resetPlots } = await deleteBookingsAndResetPlots(tx, bIds, filesToUnlink);
          deletedBookingsCount = deletedBookings;
          resetPlotsCount = resetPlots;

          // 3. Delete attributed customers
          if (custUserIds.length > 0) {
            await deleteUserChildRecords(tx, custUserIds, filesToUnlink);
            await tx`DELETE FROM users WHERE user_id IN ${tx(custUserIds)}`;
          }

          // 4. Delete team_members table row
          await tx`DELETE FROM team_members WHERE user_id = ${userId} OR mobile_no = ${targetUser.mobile_no || ''}`.catch(() => {});

          // 5. Clean team member profile & delete user row
          await deleteUserChildRecords(tx, [userId], filesToUnlink);
          await tx`DELETE FROM users WHERE user_id = ${userId}`;
          extraSummary = `Team Member "${targetUser.full_name}" (#${userId}) & attributed customer(s) deleted. ${deletedBookings} booking(s) rolled back, and ${resetPlots} plot(s) reset to Green ('Vacant').`;

        } else if (targetUser.user_type === 'Associate') {
          // 1. Find all team members under this Associate
          const tmRows = await tx`SELECT user_id FROM team_members WHERE associate_id = ${userId} AND user_id IS NOT NULL`;
          const tmUserIds = tmRows.map(r => r.user_id).filter(Boolean);

          // 2. Find all customers under this Associate or their team members
          const allSellerIds = [userId, ...tmUserIds];
          const downlineCusts = await tx`
            SELECT user_id FROM users
            WHERE (sponsor_user_id IN ${tx(allSellerIds)} OR referred_by_user_id IN ${tx(allSellerIds)})
              AND user_type = 'Customer'
          `;
          const custUserIds = downlineCusts.map(c => c.user_id);

          // 3. Find all bookings under this Associate tree
          const allTreeUserIds = [...allSellerIds, ...custUserIds];
          const assocBookings = await tx`
            SELECT booking_id FROM bookings
            WHERE user_id IN ${tx(allTreeUserIds)}
               OR sold_by_user_id IN ${tx(allSellerIds)}
               OR associate_user_id = ${userId}
               OR booked_by_user_id IN ${tx(allSellerIds)}
          `;
          const bIds = assocBookings.map(b => b.booking_id);

          const { deletedBookings, resetPlots } = await deleteBookingsAndResetPlots(tx, bIds, filesToUnlink);
          deletedBookingsCount = deletedBookings;
          resetPlotsCount = resetPlots;

          // 4. Clean customers and team members
          if (custUserIds.length > 0) {
            await deleteUserChildRecords(tx, custUserIds, filesToUnlink);
            await tx`DELETE FROM users WHERE user_id IN ${tx(custUserIds)}`;
          }
          if (tmUserIds.length > 0) {
            await deleteUserChildRecords(tx, tmUserIds, filesToUnlink);
            await tx`DELETE FROM users WHERE user_id IN ${tx(tmUserIds)}`;
          }
          await tx`DELETE FROM team_members WHERE associate_id = ${userId}`;

          // 5. Clean associate's profile & delete user row
          await deleteUserChildRecords(tx, [userId], filesToUnlink);
          await tx`DELETE FROM users WHERE user_id = ${userId}`;
          extraSummary = `Associate "${targetUser.full_name}" (#${userId}) & downline records deleted. ${deletedBookings} booking(s) rolled back, and ${resetPlots} plot(s) reset to Green ('Vacant').`;

        } else {
          // Generic user deletion (e.g. Investor, Admin)
          const userBookings = await tx`SELECT booking_id FROM bookings WHERE user_id = ${userId}`;
          const bIds = userBookings.map(b => b.booking_id);
          const { deletedBookings, resetPlots } = await deleteBookingsAndResetPlots(tx, bIds, filesToUnlink);
          deletedBookingsCount = deletedBookings;
          resetPlotsCount = resetPlots;

          await deleteUserChildRecords(tx, [userId], filesToUnlink);
          await tx`DELETE FROM users WHERE user_id = ${userId}`;
          extraSummary = `User #${userId} (${targetUser.user_type}) successfully deleted.`;
        }

        return {
          deletedId: userId,
          deletedUser: targetUser,
          deletedBookingsCount,
          resetPlotsCount,
          extraSummary
        };
      });

      // Safely unlink all physical files on disk/storage after successful DB commit
      if (filesToUnlink.length > 0) {
        await unlinkPhysicalFiles(filesToUnlink);
      }

      return ok(
        res,
        result,
        result.extraSummary || `Record #${id} successfully deleted from table "users"`
      );
    }

    // ─────────────────────────────────────────────────────────────
    // SCENARIO 2: DELETING DIRECTLY FROM 'team_members' TABLE
    // ─────────────────────────────────────────────────────────────
    if (tableName.toLowerCase() === 'team_members') {
      const tmId = Number(id);
      const [tmRow] = await sql`
        SELECT id, team_member_uid, user_id, full_name, mobile_no, associate_id
        FROM team_members
        WHERE id = ${tmId}
        LIMIT 1
      `;

      if (!tmRow) {
        return err(res, `Team Member record #${id} not found`, 404);
      }

      const filesToUnlink = [];
      const result = await sql.begin(async (tx) => {
        const tmUserId = Number(tmRow.user_id || 0);

        // 1. Find bookings sold by this team member or linked to user
        const bookingsQuery = tmUserId > 0
          ? sql`SELECT booking_id FROM bookings WHERE user_id = ${tmUserId} OR sold_by_user_id = ${tmUserId}`
          : sql`SELECT booking_id FROM bookings WHERE FALSE`;
        const bRows = await tx`${bookingsQuery}`;
        const bIds = bRows.map(b => b.booking_id);

        const { deletedBookings, resetPlots } = await deleteBookingsAndResetPlots(tx, bIds, filesToUnlink);

        // 2. If user exists, clean customer records added by this TM
        if (tmUserId > 0) {
          const downlineCusts = await tx`
            SELECT user_id FROM users
            WHERE (sponsor_user_id = ${tmUserId} OR referred_by_user_id = ${tmUserId})
              AND user_type = 'Customer'
          `;
          const custUserIds = downlineCusts.map(c => c.user_id);
          if (custUserIds.length > 0) {
            await deleteUserChildRecords(tx, custUserIds, filesToUnlink);
            await tx`DELETE FROM users WHERE user_id IN ${tx(custUserIds)}`;
          }
          await deleteUserChildRecords(tx, [tmUserId], filesToUnlink);
          await tx`DELETE FROM users WHERE user_id = ${tmUserId}`;
        }

        // 3. Delete from team_members
        await tx`DELETE FROM team_members WHERE id = ${tmId}`;

        return {
          deletedId: tmId,
          deletedBookings,
          resetPlots,
          extraSummary: `Team Member "${tmRow.full_name}" (${tmRow.team_member_uid}) deleted. ${deletedBookings} booking(s) rolled back, and ${resetPlots} plot(s) reset to Green ('Vacant').`
        };
      });

      if (filesToUnlink.length > 0) {
        await unlinkPhysicalFiles(filesToUnlink);
      }

      return ok(res, result, result.extraSummary);
    }

    // ─────────────────────────────────────────────────────────────
    // SCENARIO 3: DELETING DIRECTLY FROM 'bookings' TABLE
    // ─────────────────────────────────────────────────────────────
    if (tableName.toLowerCase() === 'bookings') {
      const bId = Number(id);
      const [booking] = await sql`
        SELECT booking_id, booking_serial, plot_id, user_id FROM bookings WHERE booking_id = ${bId} LIMIT 1
      `;
      if (!booking) {
        return err(res, `Booking #${id} not found`, 404);
      }

      const filesToUnlink = [];
      const result = await sql.begin(async (tx) => {
        const { deletedBookings, resetPlots } = await deleteBookingsAndResetPlots(tx, [bId], filesToUnlink);
        return {
          deletedId: bId,
          deletedBookings,
          resetPlots,
          extraSummary: `Booking #${booking.booking_serial || bId} deleted. Invoices/EMIs removed, and Plot reset to 'Vacant' (Green) successfully.`
        };
      });

      if (filesToUnlink.length > 0) {
        await unlinkPhysicalFiles(filesToUnlink);
      }

      return ok(res, result, result.extraSummary);
    }

    // ─────────────────────────────────────────────────────────────
    // SCENARIO 4: ALL OTHER MASTER TABLES (SAFE RELATIONAL CLEANUP)
    // ─────────────────────────────────────────────────────────────
    const [rowBeforeDelete] = await sql.unsafe(`SELECT * FROM "${tableName}" WHERE "${primaryKey}" = $1 LIMIT 1`, [id]).catch(() => []);
    if (!rowBeforeDelete) {
      return err(res, `Record with ${primaryKey}=${id} not found in ${tableName}`, 404);
    }

    // Critical system tables that must NEVER be deleted by generic cascade from other tables
    const PROTECTED_SYSTEM_TABLES = new Set([
      'home_sliders',
      'investors',
      'investor_users',
      'company_settings',
      'database_backup_settings',
      'database_backup_files',
      'sites',
      'plots',
      'admin_users',
      'payment_gateways',
      'company_bank_accounts'
    ]);

    if (cascade) {
      try {
        // Query ONLY genuine PostgreSQL Foreign Key constraints that specifically reference THIS table & primary key.
        // NEVER match column name = 'id' across all tables, which caused catastrophic cross-table deletions!
        const referencingFks = await sql`
          SELECT
            kcu.table_name AS child_table,
            kcu.column_name AS child_column
          FROM information_schema.referential_constraints rc
          JOIN information_schema.key_column_usage kcu
            ON rc.constraint_name = kcu.constraint_name
            AND rc.constraint_schema = kcu.constraint_schema
          JOIN information_schema.constraint_column_usage ccu
            ON rc.unique_constraint_name = ccu.constraint_name
            AND rc.unique_constraint_schema = ccu.constraint_schema
          WHERE ccu.table_schema = 'public'
            AND ccu.table_name = ${tableName}
            AND ccu.column_name = ${primaryKey}
        `;

        for (const ref of referencingFks) {
          const childTable = String(ref.child_table || '').toLowerCase();
          if (PROTECTED_SYSTEM_TABLES.has(childTable) || childTable === tableName.toLowerCase()) {
            continue;
          }
          try {
            await sql.unsafe(`DELETE FROM "${ref.child_table}" WHERE "${ref.child_column}" = $1`, [id]);
          } catch (refErr) {
            console.warn(`[MasterData] Safe cascade skipped for ${ref.child_table}.${ref.child_column}:`, refErr.message);
          }
        }
      } catch (cascadeErr) {
        console.warn("[MasterData] Cascade lookup error:", cascadeErr.message);
      }
    }

    const deleteSql = `DELETE FROM "${tableName}" WHERE "${primaryKey}" = $1 RETURNING *`;
    const [deletedRow] = await sql.unsafe(deleteSql, [id]);

    if (!deletedRow) {
      return err(res, `Record with ${primaryKey}=${id} not found in ${tableName}`, 404);
    }

    // Unlink any referenced physical file on disk/storage
    const filesToClean = [];
    const urlFieldNames = [
      'file_url', 'payment_screenshot_url', 'payment_proof_url', 'screenshot_url',
      'image_url', 'photo_url', 'thumbnail_url', 'aadhar_front_url', 'aadhar_back_url',
      'pan_card_url', 'signature_url', 'document_url'
    ];
    for (const key of Object.keys(rowBeforeDelete || {})) {
      const lowerKey = key.toLowerCase();
      if (urlFieldNames.includes(lowerKey) || lowerKey.endsWith('_url') || lowerKey.endsWith('_proof')) {
        const val = rowBeforeDelete[key];
        if (typeof val === 'string' && val.trim()) {
          filesToClean.push({
            url: val.trim(),
            publicId: rowBeforeDelete.file_public_id || rowBeforeDelete.public_id || ''
          });
        }
      }
    }
    if (filesToClean.length > 0) {
      await unlinkPhysicalFiles(filesToClean);
    }

    return ok(res, deletedRow, `Record #${id} successfully deleted from table "${tableName}"`);
  } catch (error) {
    console.error(`[MasterData] Error deleting from ${tableName} row ${id}:`, error);
    if (error.code === "23503") {
      return err(res, `Cannot delete record: It is referenced by other records in related tables (${error.detail || error.message}). Enable 'Force Cascade Delete' to remove related records.`, 409);
    }
    return err(res, `Failed to delete record: ` + error.message);
  }
});

/**
 * POST /api/admin/master-data/restore-system-defaults
 * Safely restores authentic default system sliders and showcase investor profiles
 * if they were inadvertently deleted or cleared.
 */
router.post("/admin/master-data/restore-system-defaults", authAdmin, requireAdminRole, async (req, res) => {
  try {
    const results = { slidersRestored: 0, investorsRestored: 0 };

    // 1. Check & restore default home sliders if missing
    const [sliderCount] = await sql`SELECT COUNT(*)::int AS count FROM home_sliders`;
    if (parseInt(sliderCount?.count || 0) <= 2) {
      const defaultSlides = [
        {
          title: "अपना सपनों का",
          subtitle: "प्लॉट बुक करें",
          description: "Kanpur, Unnao aur Lucknow mein affordable premium plots. Easy EMI, buyback guarantee aur prime location.",
          image_url: "https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?w=1600&q=80",
          tag_text: "Premium Affordable Plots",
          tag_icon: "fas fa-star",
          button_text: "Explore Plots",
          button_link: "/sites",
          button_icon: "fas fa-map-marked-alt",
          button2_text: "Register Free",
          button2_link: "/register",
          button2_icon: "fas fa-user-plus",
          thumbnail_url: "https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?w=120&q=70",
          thumbnail_title: "Explore Plots",
          thumbnail_subtitle: "5 Sites",
          stats: [{ num: "5+", lbl: "Active Sites" }, { num: "500+", lbl: "Happy Customers" }, { num: "2019", lbl: "Established" }],
        },
        {
          title: "Buyback",
          subtitle: "Guarantee",
          description: "2 saal mein buyback guarantee. Original price + ₹1,00,000 wapas. Aapka investment secure hai.",
          image_url: "https://images.unsplash.com/photo-1560518883-ce09059eeffa?w=1600&q=80",
          tag_text: "100% Secure Investment",
          tag_icon: "fas fa-shield-alt",
          button_text: "Learn More",
          button_link: "#buyback",
          button_icon: "fas fa-shield-alt",
          button2_text: "EMI Calculator",
          button2_link: "#emi",
          button2_icon: "fas fa-calculator",
          thumbnail_url: "https://images.unsplash.com/photo-1560518883-ce09059eeffa?w=120&q=70",
          thumbnail_title: "Buyback Guarantee",
          thumbnail_subtitle: "100% Secure",
          stats: [{ num: "₹1L", lbl: "Extra on Buyback" }, { num: "2 Yr", lbl: "Buyback Window" }, { num: "100%", lbl: "Safe Investment" }],
        },
        {
          title: "12 साल तक",
          subtitle: "₹12,000/माह कमाएं",
          description: "Associate बनें, plot बेचें और 12 साल तक monthly commission पाएं। 2000 gaj पर ₹3 lakh bonus भी।",
          image_url: "https://images.unsplash.com/photo-1560518883-ce09059eeffa?w=1600&q=80",
          tag_text: "Associate Commission Program",
          tag_icon: "fas fa-rupee-sign",
          button_text: "Earn With Us",
          button_link: "#earn",
          button_icon: "fas fa-hand-holding-usd",
          button2_text: "Join as Associate",
          button2_link: "/signup?type=Associate",
          button2_icon: "fas fa-user-tie",
          thumbnail_url: "https://images.unsplash.com/photo-1560518883-ce09059eeffa?w=120&q=70",
          thumbnail_title: "Earn Commission",
          thumbnail_subtitle: "12 Year Income",
          stats: [{ num: "₹600", lbl: "per 100 gaj/month" }, { num: "12 Yr", lbl: "Income Duration" }, { num: "₹3L", lbl: "Target Bonus" }],
        }
      ];

      // Run schema migrations for slider & settings
      await sql`ALTER TABLE home_sliders ALTER COLUMN title DROP NOT NULL`.catch(() => {});
      await sql`ALTER TABLE home_page_settings ADD COLUMN IF NOT EXISTS slider_show_indicator BOOLEAN NOT NULL DEFAULT TRUE`.catch(() => {});
      await sql`ALTER TABLE home_page_settings ADD COLUMN IF NOT EXISTS slider_darkness INTEGER NOT NULL DEFAULT 45`.catch(() => {});

      for (let i = 0; i < defaultSlides.length; i++) {
        const s = defaultSlides[i];
        const [exists] = await sql`SELECT id FROM home_sliders WHERE title = ${s.title} LIMIT 1`;
        if (!exists) {
          await sql`
            INSERT INTO home_sliders (
              title, subtitle, description, image_url, tag_text, tag_icon,
              button_text, button_link, button_icon, button2_text, button2_link, button2_icon,
              thumbnail_url, thumbnail_title, thumbnail_subtitle, stats_json,
              display_order, is_active
            ) VALUES (
              ${s.title}, ${s.subtitle}, ${s.description}, ${s.image_url},
              ${s.tag_text}, ${s.tag_icon},
              ${s.button_text}, ${s.button_link}, ${s.button_icon},
              ${s.button2_text}, ${s.button2_link}, ${s.button2_icon},
              ${s.thumbnail_url}, ${s.thumbnail_title}, ${s.thumbnail_subtitle},
              ${sql.json(s.stats)}, ${i + 1}, TRUE
            )
          `;
          results.slidersRestored++;
        }
      }
    }

    // 2. Check & restore default investor if missing
    const [invCount] = await sql`SELECT COUNT(*)::int AS count FROM investors WHERE is_deleted = FALSE`;
    if (parseInt(invCount?.count || 0) === 0) {
      await sql`
        INSERT INTO investors (name, profile_image_url, designation, short_description, display_order, is_active, is_deleted)
        VALUES (
          'Suraj Kumar Verma',
          'https://api.mmrconstructions.in/uploads/investors/1/profile/mmr-constructions-investor-1-investorphoto-20260811-292982.png',
          'Chief Investor & Partner',
          'Primary Strategic Investor and Founding Partner at MMR Constructions.',
          1,
          TRUE,
          FALSE
        )
      `;
      results.investorsRestored++;
    }

    // 3. Check & restore investor_users account if missing
    const [invUserCount] = await sql`SELECT COUNT(*)::int AS count FROM investor_users WHERE deleted_at IS NULL`;
    if (parseInt(invUserCount?.count || 0) === 0) {
      await sql`
        INSERT INTO investor_users (
          full_name, mobile_number, email, password_hash,
          address, city, state, pincode, pan_number, aadhaar_number,
          bank_name, account_number, ifsc_code,
          available_balance, total_investment, total_deposits, total_withdrawals,
          status, is_verified, enrollment_status
        ) VALUES (
          'Suraj Kumar Verma', '9999999999', 'investor@mmrconstructions.in',
          '$2a$10$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNO',
          'Kanpur, UP', 'Kanpur', 'Uttar Pradesh', '208001', 'ABCDE1234F', '123456789012',
          'HDFC Bank', '50200085321372', 'HDFC0001254',
          50000.00, 500000.00, 500000.00, 0.00,
          'active', TRUE, 'Completed'
        )
      `;
      results.investorsRestored++;
    }

    return ok(res, results, "System default data restored successfully.");
  } catch (error) {
    console.error("[MasterData] Error restoring defaults:", error);
    return err(res, "Failed to restore defaults: " + error.message);
  }
});

export default router;
