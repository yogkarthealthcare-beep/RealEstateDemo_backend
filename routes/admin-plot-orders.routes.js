/**
 * MMR Construction & Developers Pvt. Ltd.
 * Dedicated Admin Plot Booking Orders Management API
 * 
 * Endpoints:
 * 1. GET   /api/admin/plot-orders          - List all plot booking orders with filters & stats
 * 2. GET   /api/admin/plot-orders/:id      - Get full details of a specific plot booking order
 * 3. PATCH /api/admin/plot-orders/:id/status - Approve, Reject or update status of an order
 * 4. POST  /api/admin/plot-orders/:id/generate-invoice - Ensure/generate invoice record
 */

import express from 'express';
import sql from '../db.js';
import { verifyAdminToken, verifyUserToken, role, resolveEffectivePanel } from '../middleware/auth.middleware.js';
import commissionService from '../services/commissionService.js';
import { setPlotStatus } from '../services/plotStatus.service.js';

const router = express.Router();

function ok(res, data = null, message = 'Success', extra = {}) {
  return res.json({ success: true, message, data, ...extra });
}

function err(res, message = 'Error', code = 400) {
  return res.status(code).json({ success: false, message });
}

// Automatically ensure sequence and default on invoices.invoice_id in DB if missing, and ensure sponsor_id on users
(async () => {
  try {
    await sql`
      DO $$
      BEGIN
        IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'invoices') THEN
          CREATE SEQUENCE IF NOT EXISTS invoices_invoice_id_seq;
          PERFORM setval('invoices_invoice_id_seq', COALESCE((SELECT MAX(invoice_id) FROM invoices), 0) + 1, false);
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'invoices' AND column_name = 'invoice_id' AND column_default IS NOT NULL
          ) THEN
            ALTER TABLE invoices ALTER COLUMN invoice_id SET DEFAULT nextval('invoices_invoice_id_seq');
          END IF;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'users' AND column_name = 'sponsor_id'
        ) THEN
          ALTER TABLE users ADD COLUMN sponsor_id INTEGER;
          IF EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'users' AND column_name = 'sponsor_user_id'
          ) THEN
            UPDATE users SET sponsor_id = sponsor_user_id WHERE sponsor_id IS NULL AND sponsor_user_id IS NOT NULL;
          END IF;
        END IF;

        -- Auto-heal zero-price bookings and invoices
        UPDATE bookings 
        SET base_price = COALESCE(NULLIF(requested_price, 0), NULLIF(remaining_balance + advance_amount, 0), 2000000)
        WHERE (base_price = 0 OR base_price IS NULL) AND (requested_price > 0 OR (remaining_balance + advance_amount) > 0);

        UPDATE invoices i
        SET total_amount = b.base_price,
            subtotal = b.base_price,
            remaining_balance = GREATEST(0, b.base_price - COALESCE(i.paid_amount, b.advance_amount, 0))
        FROM bookings b
        WHERE i.booking_id = b.booking_id AND (i.total_amount = 0 OR i.total_amount IS NULL) AND b.base_price > 0;
      EXCEPTION WHEN OTHERS THEN
        NULL;
      END $$;
    `;
  } catch (schemaErr) {
    console.warn('[AdminPlotOrders] schema auto-setup notice:', schemaErr.message);
  }
})();

// Helper to create or ensure an invoice record exists for a booking
async function createOrGetInvoice(bookingId) {
  const [booking] = await sql`
    SELECT b.*, p.plot_id, p.plot_number, p.plot_area, p.sold_price, p.base_price AS plot_base_price,
           s.site_name, s.city AS site_city,
           u.full_name AS buyer_name, u.mobile_no AS buyer_mobile, u.email AS buyer_email,
           b_addr.address_line1 AS buyer_address,
           assoc.full_name AS associate_name, assoc.mobile_no AS associate_mobile
    FROM bookings b
    LEFT JOIN plots p ON p.plot_id = b.plot_id
    LEFT JOIN sites s ON s.site_id = p.site_id
    LEFT JOIN users u ON u.user_id = b.user_id
    LEFT JOIN user_addresses b_addr ON b_addr.user_id = b.user_id
    LEFT JOIN users assoc ON assoc.user_id = b.associate_user_id
    WHERE b.booking_id = ${bookingId}
    LIMIT 1
  `;

  if (!booking) throw new Error('Booking order not found');

  const saleVal = Number(
    (booking.base_price > 0 ? booking.base_price : null) || 
    (booking.requested_price > 0 ? booking.requested_price : null) ||
    (booking.sold_price > 0 ? booking.sold_price : null) || 
    (booking.plot_base_price > 0 ? booking.plot_base_price : null) || 
    (Number(booking.advance_amount || 0) + Number(booking.remaining_balance || 0) > 0 ? Number(booking.advance_amount || 0) + Number(booking.remaining_balance || 0) : null) || 
    0
  );

  const [existingInv] = await sql`
    SELECT * FROM invoices 
    WHERE booking_id = ${bookingId} 
       OR order_id = ${booking.booking_serial || `ORDER-${bookingId}`}
    ORDER BY invoice_id DESC 
    LIMIT 1
  `.catch(() => []);

  if (existingInv) {
    if (Number(existingInv.total_amount || 0) <= 0 && saleVal > 0) {
      const advVal = Number(booking.advance_amount || 0);
      const remBal = Math.max(0, saleVal - advVal);
      const paymentStatus = advVal >= saleVal ? 'Paid' : (advVal > 0 ? 'Partially Paid' : 'Unpaid');
      await sql`
        UPDATE invoices 
        SET total_amount = ${saleVal}, subtotal = ${saleVal}, remaining_balance = ${remBal}, payment_status = ${paymentStatus}, updated_at = NOW()
        WHERE invoice_id = ${existingInv.invoice_id}
      `.catch(() => {});
      existingInv.total_amount = saleVal;
      existingInv.subtotal = saleVal;
      existingInv.remaining_balance = remBal;
      existingInv.payment_status = paymentStatus;
    }
    return existingInv;
  }

  const invNum = `MMR-INV-${new Date().getFullYear()}-${String(bookingId).padStart(6, '0')}`;
  const advVal = Number(booking.advance_amount || 0);
  const remBal = Math.max(0, saleVal - advVal);
  const paymentStatus = advVal >= saleVal ? 'Paid' : (advVal > 0 ? 'Partially Paid' : 'Unpaid');

  const invData = {
    invoice_number: invNum,
    invoice_type: 'Plot Booking Order Invoice',
    booking_id: booking.booking_id,
    booking_serial: booking.booking_serial || `BK-${booking.booking_id}`,
    customer_name: booking.buyer_name || 'Valued Customer',
    mobile_no: booking.buyer_mobile || '',
    email: booking.buyer_email || '',
    address: booking.buyer_address || '',
    associate_name: booking.associate_name || '',
    associate_mobile: booking.associate_mobile || '',
    associate_id: booking.associate_user_id || '',
    site_name: booking.site_name || 'MMR City',
    plot_number: booking.plot_number || 'Plot',
    plot_size: `${booking.plot_area || ''} Gaj`.trim(),
    total_plot_price: saleVal,
    down_payment: advVal,
    grand_total: saleVal,
    paid_amount: advVal,
    balance_amount: remBal,
    payment_method: booking.payment_method || 'Bank Transfer',
    payment_status: paymentStatus,
    order_status: 'Completed',
    created_at: new Date()
  };

  // Safe invoice ID calculation (handles tables without sequence/default)
  const [maxRow] = await sql`
    SELECT COALESCE(MAX(invoice_id), 0) + 1 AS next_id FROM invoices
  `.catch(() => [{ next_id: 1 }]);
  const nextInvoiceId = Number(maxRow?.next_id || 1);

  let newInv;
  try {
    [newInv] = await sql`
      INSERT INTO invoices (
        invoice_id, invoice_number, booking_id, user_id, associate_id, order_id, invoice_date,
        subtotal, grand_total, paid_amount, balance_amount, payment_status, payment_method,
        order_status, invoice_data, created_at, updated_at
      ) VALUES (
        ${nextInvoiceId}, ${invNum}, ${bookingId}, ${booking.user_id}, ${booking.associate_user_id || null},
        ${booking.booking_serial || `ORDER-${bookingId}`}, NOW(),
        ${saleVal}, ${saleVal}, ${advVal}, ${remBal},
        ${paymentStatus},
        ${booking.payment_method || 'Bank Transfer'},
        'Completed',
        ${sql.json(invData)},
        NOW(), NOW()
      )
      RETURNING *
    `;
  } catch (errWithId) {
    try {
      [newInv] = await sql`
        INSERT INTO invoices (
          invoice_number, booking_id, user_id, associate_id, order_id, invoice_date,
          subtotal, grand_total, paid_amount, balance_amount, payment_status, payment_method,
          order_status, invoice_data, created_at, updated_at
        ) VALUES (
          ${invNum}, ${bookingId}, ${booking.user_id}, ${booking.associate_user_id || null},
          ${booking.booking_serial || `ORDER-${bookingId}`}, NOW(),
          ${saleVal}, ${saleVal}, ${advVal}, ${remBal},
          ${paymentStatus},
          ${booking.payment_method || 'Bank Transfer'},
          'Completed',
          ${sql.json(invData)},
          NOW(), NOW()
        )
        RETURNING *
      `;
    } catch (insertErr) {
      const [fallbackInv] = await sql`
        SELECT * FROM invoices 
        WHERE booking_id = ${bookingId} 
           OR order_id = ${booking.booking_serial || `ORDER-${bookingId}`}
        LIMIT 1
      `.catch(() => []);
      if (fallbackInv) {
        newInv = fallbackInv;
      } else {
        throw insertErr;
      }
    }
  }

  // Also sync booking_invoices table for legacy compatibility
  await sql`
    INSERT INTO booking_invoices (invoice_number, booking_id, user_id, invoice_data)
    VALUES (${invNum}, ${bookingId}, ${booking.user_id}, ${sql.json(invData)})
  `.catch(() => {});

  return newInv;
}


/**
 * Resolve role-based scoping filter for user/portal callers.
 * Enforces strict isolation:
 * - Team Member: ONLY self-purchases and direct customer sales booked by/for this TM.
 * - Associate: Personal purchases, direct customer bookings, and bookings from their downline team members.
 * - Customer: Only plots purchased by customer.
 * - Admin: Unrestricted (TRUE).
 */
async function resolvePlotOrderScope(req) {
  const userId = Number(req.user?.user_id || req.user?.id);
  if (!userId) {
    return { error: 'Unauthorized: User identity missing', status: 401 };
  }

  const [caller] = await sql`
    SELECT user_id, user_type, member_id, referred_by_user_id, account_status
    FROM users
    WHERE user_id = ${userId}
    LIMIT 1
  `;

  if (!caller) {
    return { error: 'User account not found', status: 404 };
  }

  const effectivePanel = resolveEffectivePanel(req.user);
  const isTm = effectivePanel === 'team-member' ||
               caller.user_type === 'Team Member' ||
               String(caller.member_id || '').toUpperCase().startsWith('MMR-TM-');

  const isAssoc = !isTm && (
    effectivePanel === 'associate' ||
    caller.user_type === 'Associate' ||
    Boolean(req.user?.is_associate)
  );

  const isAdmin = Boolean(req.user?.is_admin || req.user?.admin_id || ['SuperAdmin', 'Admin', 'FinanceManager'].includes(caller.user_type));

  if (isAdmin) {
    return { role: 'admin', scopeFilter: sql`TRUE`, caller };
  }

  if (isTm) {
    // Team Member strict isolation:
    // Can ONLY see orders booked by themselves (self or customer):
    const scopeFilter = sql`(
      b.user_id = ${userId}
      OR b.sold_by_user_id = ${userId}
      OR b.booked_by_user_id = ${userId}
    )`;
    return { role: 'team-member', scopeFilter, caller };
  }

  if (isAssoc) {
    // Associate strict isolation:
    // Personal purchases, direct customer sales, upline bookings,
    // and bookings made by/for downline team members under this associate.
    const scopeFilter = sql`(
      b.user_id = ${userId}
      OR b.sold_by_user_id = ${userId}
      OR b.booked_by_user_id = ${userId}
      OR b.associate_user_id = ${userId}
      OR b.sold_by_user_id IN (
        SELECT tm.user_id FROM team_members tm 
        WHERE tm.associate_id = ${userId} AND tm.user_id IS NOT NULL
      )
      OR b.sold_by_user_id IN (
        SELECT u2.user_id FROM users u2 
        WHERE (u2.sponsor_user_id = ${userId} OR u2.referred_by_user_id = ${userId})
          AND u2.user_id IS NOT NULL
      )
      OR b.booked_by_user_id IN (
        SELECT tm2.user_id FROM team_members tm2 
        WHERE tm2.associate_id = ${userId} AND tm2.user_id IS NOT NULL
      )
      OR b.booked_by_user_id IN (
        SELECT u3.user_id FROM users u3 
        WHERE (u3.sponsor_user_id = ${userId} OR u3.referred_by_user_id = ${userId})
          AND u3.user_id IS NOT NULL
      )
      OR b.user_id IN (
        SELECT u4.user_id FROM users u4 
        WHERE (u4.sponsor_user_id = ${userId} OR u4.referred_by_user_id = ${userId})
          AND u4.user_id IS NOT NULL
      )
    )`;
    return { role: 'associate', scopeFilter, caller };
  }

  // Fallback for regular customer
  const scopeFilter = sql`b.user_id = ${userId}`;
  return { role: 'customer', scopeFilter, caller };
}

/**
 * Shared query executor for Plot Orders list & KPI metrics.
 */
async function executePlotOrdersQuery(req, res, scopeFilter = sql`TRUE`, extraMeta = {}) {
  try {
    const {
      search = '',
      status = '',
      booking_type = '',
      site_id = '',
      payment_type = '',
      from_date = '',
      to_date = '',
      page = 1,
      limit = 15,
      sort_by = 'latest'
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, Math.min(100, parseInt(limit, 10) || 15));
    const offset = (pageNum - 1) * limitNum;

    const q = String(search || '').trim();
    const searchFilter = q ? sql`
      (
        b.booking_serial ILIKE ${'%' + q + '%'}
        OR CAST(b.booking_id AS TEXT) ILIKE ${'%' + q + '%'}
        OR buyer.full_name ILIKE ${'%' + q + '%'}
        OR buyer.member_id ILIKE ${'%' + q + '%'}
        OR buyer.mobile_no ILIKE ${'%' + q + '%'}
        OR p.plot_number ILIKE ${'%' + q + '%'}
        OR s.site_name ILIKE ${'%' + q + '%'}
        OR seller.full_name ILIKE ${'%' + q + '%'}
        OR seller.member_id ILIKE ${'%' + q + '%'}
        OR assoc.full_name ILIKE ${'%' + q + '%'}
        OR assoc.member_id ILIKE ${'%' + q + '%'}
      )
    ` : sql`TRUE`;

    const statusFilter = status && status !== 'ALL'
      ? (status === 'Approved' || status === 'Confirmed'
          ? sql`b.booking_status IN ('Confirmed', 'Approved')`
          : (status === 'Pending'
              ? sql`b.booking_status IN ('Pending', 'PaymentPending', 'Under Process')`
              : sql`b.booking_status ILIKE ${status}`))
      : sql`TRUE`;

    const bookingTypeFilter = booking_type && booking_type !== 'ALL'
      ? (booking_type === 'SELF_PURCHASE'
          ? sql`(COALESCE(buyer.user_type, 'Customer') != 'Customer' AND (b.booking_type = 'SELF_PURCHASE' OR b.user_id = b.sold_by_user_id))`
          : sql`(COALESCE(buyer.user_type, 'Customer') = 'Customer' OR (b.booking_type != 'SELF_PURCHASE' AND b.user_id != COALESCE(b.sold_by_user_id, 0)))`)
      : sql`TRUE`;

    const siteFilter = site_id ? sql`p.site_id = ${Number(site_id)}` : sql`TRUE`;
    const paymentTypeFilter = payment_type ? sql`b.payment_type = ${payment_type}` : sql`TRUE`;
    const fromDateFilter = from_date ? sql`b.created_at >= ${from_date}::timestamptz` : sql`TRUE`;
    const toDateFilter = to_date ? sql`b.created_at <= (${to_date}::date + INTERVAL '1 day')::timestamptz` : sql`TRUE`;

    // Calculate aggregated metrics respecting the scopeFilter
    const [metrics] = await sql`
      SELECT
        COUNT(*)::int AS total_orders,
        COUNT(CASE WHEN b.booking_status IN ('Confirmed', 'Approved') THEN 1 END)::int AS approved_count,
        COUNT(CASE WHEN b.booking_status IN ('Pending', 'PaymentPending', 'Under Process') THEN 1 END)::int AS pending_count,
        COUNT(CASE WHEN b.booking_status = 'Rejected' THEN 1 END)::int AS rejected_count,
        COUNT(CASE WHEN (COALESCE(buyer.user_type, 'Customer') != 'Customer' AND (b.booking_type = 'SELF_PURCHASE' OR b.user_id = b.sold_by_user_id)) THEN 1 END)::int AS self_purchase_count,
        COUNT(CASE WHEN (COALESCE(buyer.user_type, 'Customer') = 'Customer' OR (b.booking_type != 'SELF_PURCHASE' AND b.user_id != COALESCE(b.sold_by_user_id, 0))) THEN 1 END)::int AS customer_sale_count,
        COALESCE(SUM(COALESCE(NULLIF(b.base_price, 0), NULLIF(b.requested_price, 0), NULLIF(p.sold_price, 0), NULLIF(p.base_price, 0), (b.advance_amount + b.remaining_balance), 0)), 0)::numeric AS total_sales_volume,
        COALESCE(SUM(COALESCE(b.advance_amount, 0)), 0)::numeric AS total_advance_volume
      FROM bookings b
      LEFT JOIN plots p ON p.plot_id = b.plot_id
      LEFT JOIN sites s ON s.site_id = p.site_id
      LEFT JOIN users buyer ON buyer.user_id = b.user_id
      LEFT JOIN users seller ON seller.user_id = b.sold_by_user_id
      LEFT JOIN users assoc ON assoc.user_id = b.associate_user_id
      WHERE ${scopeFilter}
        AND ${searchFilter}
        AND ${statusFilter}
        AND ${bookingTypeFilter}
        AND ${siteFilter}
        AND ${paymentTypeFilter}
        AND ${fromDateFilter}
        AND ${toDateFilter}
    `;

    // Query paginated orders with enriched joins
    const orders = await sql`
      SELECT
        b.booking_id,
        b.booking_serial,
        COALESCE(b.booking_date, b.created_at) AS booking_date,
        b.booking_status,
        b.workflow_status,
        b.associate_approval_status,
        b.associate_rejection_reason,
        b.booking_type,
        (COALESCE(buyer.user_type, 'Customer') != 'Customer' AND (b.booking_type = 'SELF_PURCHASE' OR b.user_id = b.sold_by_user_id)) AS is_self_purchase,
        b.payment_type,
        b.payment_method,
        COALESCE(b.advance_amount, 0) AS advance_amount,
        COALESCE(b.remaining_balance, 0) AS remaining_balance,
        COALESCE(NULLIF(b.base_price, 0), NULLIF(b.requested_price, 0), NULLIF(p.sold_price, 0), NULLIF(p.base_price, 0), (b.advance_amount + b.remaining_balance), 0) AS total_agreed_price,
        b.notes,
        b.created_at,
        b.confirmed_at,

        -- Buyer details
        b.user_id AS buyer_user_id,
        buyer.full_name AS buyer_name,
        buyer.member_id AS buyer_member_id,
        buyer.mobile_no AS buyer_mobile,
        buyer.email AS buyer_email,
        buyer.user_type AS buyer_user_type,
        COALESCE(b_addr.city, '') AS buyer_city,

        -- Sold by (Team Member) details
        b.sold_by_user_id,
        seller.full_name AS team_member_name,
        seller.member_id AS team_member_member_id,
        seller.mobile_no AS team_member_mobile,
        seller.user_type AS team_member_user_type,

        -- Associate details
        b.associate_user_id,
        assoc.full_name AS associate_name,
        assoc.member_id AS associate_member_id,
        assoc.mobile_no AS associate_mobile,

        -- Booker details (who placed the booking)
        b.booked_by_user_id,
        booker.full_name AS booked_by_name,
        booker.member_id AS booked_by_member_id,

        -- Plot details
        p.plot_id,
        p.plot_number,
        COALESCE(p.plot_area, 0) AS plot_area,
        'Gaj' AS area_unit,
        COALESCE(p.plot_status, 'Vacant') AS plot_status,
        COALESCE(p.unit_type, 'PLOT') AS unit_type,

        -- Site details
        s.site_id,
        s.site_name,
        COALESCE(s.full_address, s.city, '') AS site_location,
        COALESCE(s.city, '') AS site_city,

        -- Invoice details
        inv.invoice_id,
        inv.invoice_number,
        inv.payment_status AS invoice_payment_status,
        inv.paid_amount AS invoice_paid_amount,

        -- Payment Proof details (Task 6: booking_payment_proofs only)
        proof.proof_url,
        COALESCE(proof.proof_payer, b.payer_name, buyer.full_name, '') AS proof_payer,
        COALESCE(proof.proof_utr, b.utr_number, '') AS proof_utr,
        COALESCE(b.advance_amount, 0) AS proof_amount,
        COALESCE(b.payment_method, b.payment_type, 'UPI') AS proof_mode

      FROM bookings b
      LEFT JOIN plots p ON p.plot_id = b.plot_id
      LEFT JOIN sites s ON s.site_id = p.site_id
      LEFT JOIN users buyer ON buyer.user_id = b.user_id
      LEFT JOIN LATERAL (
        SELECT address_line1, city, state, pin_code, country FROM user_addresses
        WHERE user_id = b.user_id AND address_type = 'Permanent'
        ORDER BY address_id DESC LIMIT 1
      ) b_addr ON TRUE
      LEFT JOIN users seller ON seller.user_id = b.sold_by_user_id
      LEFT JOIN users assoc ON assoc.user_id = b.associate_user_id
      LEFT JOIN users booker ON booker.user_id = b.booked_by_user_id
      LEFT JOIN LATERAL (
        SELECT invoice_id, invoice_number, payment_status, paid_amount
        FROM invoices
        WHERE booking_id = b.booking_id
        ORDER BY invoice_id DESC
        LIMIT 1
      ) inv ON TRUE
      LEFT JOIN LATERAL (
        SELECT file_path AS proof_url, payer_name AS proof_payer, utr_number AS proof_utr
        FROM booking_payment_proofs
        WHERE booking_id = b.booking_id
        LIMIT 1
      ) proof ON TRUE
      WHERE ${scopeFilter}
        AND ${searchFilter}
        AND ${statusFilter}
        AND ${bookingTypeFilter}
        AND ${siteFilter}
        AND ${paymentTypeFilter}
        AND ${fromDateFilter}
        AND ${toDateFilter}
      ORDER BY b.booking_id DESC
      LIMIT ${limitNum} OFFSET ${offset}
    `;

    const total = metrics?.total_orders || 0;
    const totalPages = Math.ceil(total / limitNum) || 1;

    return ok(res, {
      orders,
      metrics: {
        total_orders: metrics?.total_orders || 0,
        approved_count: metrics?.approved_count || 0,
        pending_count: metrics?.pending_count || 0,
        rejected_count: metrics?.rejected_count || 0,
        self_purchase_count: metrics?.self_purchase_count || 0,
        customer_sale_count: metrics?.customer_sale_count || 0,
        total_sales_volume: Number(metrics?.total_sales_volume || 0),
        total_advance_volume: Number(metrics?.total_advance_volume || 0)
      },
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        pages: totalPages
      },
      ...extraMeta
    }, 'Plot orders fetched successfully');
  } catch (e) {
    console.error('[PlotOrders] Error fetching orders:', e);
    return err(res, e.message || 'Failed to fetch plot orders', 500);
  }
}

/**
 * Shared query executor for a single Plot Order's detail & payment log.
 */
async function executePlotOrderDetailQuery(req, res, bookingId, scopeFilter = sql`TRUE`) {
  try {
    const [order] = await sql`
      SELECT
        b.*,
        (COALESCE(buyer.user_type, 'Customer') != 'Customer' AND (b.booking_type = 'SELF_PURCHASE' OR b.user_id = b.sold_by_user_id)) AS is_self_purchase,
        COALESCE(NULLIF(b.base_price, 0), NULLIF(b.requested_price, 0), NULLIF(p.sold_price, 0), NULLIF(p.base_price, 0), (b.advance_amount + b.remaining_balance), 0) AS total_agreed_price,

        -- Buyer
        buyer.full_name AS buyer_name,
        buyer.member_id AS buyer_member_id,
        buyer.mobile_no AS buyer_mobile,
        buyer.email AS buyer_email,
        buyer.user_type AS buyer_user_type,
        COALESCE(b_addr.address_line1, '') AS buyer_address,
        COALESCE(b_addr.city, '') AS buyer_city,
        COALESCE(b_addr.state, '') AS buyer_state,
        COALESCE(b_addr.pin_code, '') AS buyer_pincode,
        COALESCE(k.status, 'Not Submitted') AS buyer_kyc_status,

        -- Team Member
        seller.full_name AS team_member_name,
        seller.member_id AS team_member_member_id,
        seller.mobile_no AS team_member_mobile,
        seller.email AS team_member_email,
        seller.user_type AS team_member_user_type,

        -- Associate
        assoc.full_name AS associate_name,
        assoc.member_id AS associate_member_id,
        assoc.mobile_no AS associate_mobile,

        -- Booker
        booker.full_name AS booked_by_name,
        booker.member_id AS booked_by_member_id,

        -- Plot
        p.plot_number,
        COALESCE(p.plot_area, 0) AS plot_area,
        'Gaj' AS area_unit,
        COALESCE(p.plot_status, 'Vacant') AS plot_status,
        COALESCE(p.unit_type, 'PLOT') AS unit_type,
        'East Facing' AS facing,
        COALESCE(p.base_price, 0) AS plot_master_base_price,

        -- Site
        s.site_name,
        COALESCE(s.city, 'Varanasi') AS site_location,
        COALESCE(s.full_address, s.city, '') AS site_address,
        COALESCE(s.city, '') AS site_city,
        COALESCE(s.state, 'Uttar Pradesh') AS site_state,
        COALESCE(s.description, '') AS site_description,

        -- Invoices
        inv.invoice_id,
        inv.invoice_number,
        inv.payment_status AS invoice_payment_status,
        inv.paid_amount AS invoice_paid_amount,
        inv.balance_amount AS invoice_balance_amount,
        inv.grand_total AS invoice_grand_total

      FROM bookings b
      LEFT JOIN plots p ON p.plot_id = b.plot_id
      LEFT JOIN sites s ON s.site_id = p.site_id
      LEFT JOIN users buyer ON buyer.user_id = b.user_id
      LEFT JOIN LATERAL (
        SELECT address_line1, city, state, pin_code, country FROM user_addresses
        WHERE user_id = b.user_id AND address_type = 'Permanent'
        ORDER BY address_id DESC LIMIT 1
      ) b_addr ON TRUE
      LEFT JOIN user_kyc_profiles k ON k.user_id = b.user_id
      LEFT JOIN users seller ON seller.user_id = b.sold_by_user_id
      LEFT JOIN users assoc ON assoc.user_id = b.associate_user_id
      LEFT JOIN users booker ON booker.user_id = b.booked_by_user_id
      LEFT JOIN LATERAL (
        SELECT * FROM invoices
        WHERE booking_id = b.booking_id
        ORDER BY invoice_id DESC
        LIMIT 1
      ) inv ON TRUE
      WHERE b.booking_id = ${bookingId}
        AND ${scopeFilter}
    `;

    if (!order) {
      return err(res, 'Booking order not found or access unauthorized', 404);
    }

    // Fetch related payment transactions or receipts if any
    const payments = await sql`
      SELECT
        payment_id,
        amount,
        payment_date,
        payment_mode,
        payment_status,
        transaction_id,
        receipt_no
      FROM payments
      WHERE booking_id = ${bookingId}
      ORDER BY payment_id DESC
    `.catch(() => []);

    return ok(res, { order, payments }, 'Booking order details retrieved successfully');
  } catch (e) {
    console.error('[PlotOrders] Error fetching order detail:', e);
    return err(res, e.message || 'Failed to fetch booking order details', 500);
  }
}

/**
 * 1. GET /api/admin/plot-orders
 * List plot booking orders with rich search, pagination, and summary KPIs (Admin Master View).
 */
router.get('/admin/plot-orders', verifyAdminToken, async (req, res) => {
  return executePlotOrdersQuery(req, res, sql`TRUE`, { audience: 'admin' });
});

router.get('/admin/plot-orders/search-invoices', verifyAdminToken, async (req, res) => {
  try {
    const {
      search = '',
      user_type = 'All',
      selected_user_id,
      status_filter = 'All',
      payment_type_filter = 'All',
      from_date,
      to_date,
      sort = 'latest'
    } = req.query;

    const searchTerm = String(search || '').trim().toLowerCase();
    const searchNum = Number(searchTerm);

    // 1. Search matching users across `users` and `investor_users`
    let matchedUsers = [];

    // A. Users table (Customer, Associate, Team Member)
    if (user_type === 'All' || user_type === 'Customer' || user_type === 'Associate') {
      const typeCond = user_type === 'Customer'
        ? sql`AND LOWER(u.user_type::text) = 'customer'`
        : (user_type === 'Associate'
          ? sql`AND (LOWER(u.user_type::text) = 'associate' OR LOWER(u.user_type::text) = 'team member')`
          : sql`AND LOWER(u.user_type::text) != 'investor'`);

      const searchCond = searchTerm ? sql`
        AND (
          ${!isNaN(searchNum) && searchNum > 0 ? sql`u.user_id = ${searchNum} OR` : sql``}
          LOWER(COALESCE(u.member_id, '')) LIKE ${'%' + searchTerm + '%'}
          OR LOWER(COALESCE(u.full_name, '')) LIKE ${'%' + searchTerm + '%'}
          OR COALESCE(u.mobile_no, '') LIKE ${'%' + searchTerm + '%'}
          OR LOWER(COALESCE(u.email, '')) LIKE ${'%' + searchTerm + '%'}
        )
      ` : sql``;

      const mainUsers = await sql`
        SELECT 
          u.user_id,
          u.member_id,
          u.full_name,
          u.mobile_no,
          u.email,
          u.user_type,
          u.account_status
        FROM users u
        WHERE 1=1
          ${typeCond}
          ${searchCond}
        ORDER BY u.user_id ASC
        LIMIT 100
      `;

      for (const u of mainUsers) {
        matchedUsers.push({
          user_id: u.user_id,
          member_id: u.member_id || `USR-${u.user_id}`,
          full_name: u.full_name || 'Unnamed User',
          mobile_no: u.mobile_no || '',
          email: u.email || '',
          user_type: u.user_type === 'Team Member' ? 'Associate' : u.user_type,
          raw_user_type: u.user_type,
          account_status: u.account_status || 'Active',
          source_table: 'users'
        });
      }
    }

    // B. Investor Users table
    if (user_type === 'All' || user_type === 'Investor') {
      const searchCond = searchTerm ? sql`
        AND (
          ${!isNaN(searchNum) && searchNum > 0 ? sql`inv.id = ${searchNum} OR` : sql``}
          LOWER(COALESCE(inv.member_id, '')) LIKE ${'%' + searchTerm + '%'}
          OR LOWER(COALESCE(inv.full_name, '')) LIKE ${'%' + searchTerm + '%'}
          OR COALESCE(inv.mobile_number, '') LIKE ${'%' + searchTerm + '%'}
          OR LOWER(COALESCE(inv.email, '')) LIKE ${'%' + searchTerm + '%'}
        )
      ` : sql``;

      const investorUsers = await sql`
        SELECT 
          inv.id AS user_id,
          inv.member_id,
          inv.full_name,
          inv.mobile_number AS mobile_no,
          inv.email,
          'Investor' AS user_type,
          inv.status AS account_status
        FROM investor_users inv
        WHERE inv.deleted_at IS NULL
          ${searchCond}
        ORDER BY inv.id ASC
        LIMIT 100
      `;

      for (const inv of investorUsers) {
        matchedUsers.push({
          user_id: inv.user_id,
          member_id: inv.member_id || `INV-${inv.user_id}`,
          full_name: inv.full_name || 'Unnamed Investor',
          mobile_no: inv.mobile_no || '',
          email: inv.email || '',
          user_type: 'Investor',
          raw_user_type: 'Investor',
          account_status: inv.account_status || 'active',
          source_table: 'investor_users'
        });
      }
    }

    // 2. Fetch order metrics for all matched users (non-duplicate calculation)
    const userIds = matchedUsers.filter(u => u.source_table === 'users').map(u => u.user_id);
    const investorEmails = matchedUsers.filter(u => u.source_table === 'investor_users').map(u => u.email.toLowerCase()).filter(Boolean);

    let userMetrics = {};
    if (userIds.length > 0 || investorEmails.length > 0) {
      const allOrders = await sql`
        SELECT 
          b.booking_id,
          b.user_id,
          b.plot_id,
          COALESCE(NULLIF(b.base_price, 0), NULLIF(b.requested_price, 0), NULLIF(p.sold_price, 0), NULLIF(p.base_price, 0), (b.advance_amount + b.remaining_balance), 0) AS final_price,
          COALESCE(b.advance_amount, 0) AS advance_amount,
          COALESCE(b.remaining_balance, 0) AS remaining_balance,
          LOWER(COALESCE(u.email, '')) AS user_email
        FROM bookings b
        LEFT JOIN plots p ON p.plot_id = b.plot_id
        LEFT JOIN users u ON u.user_id = b.user_id
        WHERE b.user_id IN ${userIds.length ? sql(userIds) : sql`(-1)`}
           OR LOWER(COALESCE(u.email, '')) IN ${investorEmails.length ? sql(investorEmails) : sql`('__none__')`}
      `;

      const bIds = allOrders.map(o => o.booking_id);
      let emiPaidMap = {};
      if (bIds.length > 0) {
        const emiSums = await sql`
          SELECT booking_id, COALESCE(SUM(paid_amount), 0) AS total_emi_paid
          FROM emi_schedules
          WHERE booking_id IN ${sql(bIds)}
          GROUP BY booking_id
        `;
        for (const e of emiSums) {
          emiPaidMap[e.booking_id] = Number(e.total_emi_paid || 0);
        }
      }

      for (const ord of allOrders) {
        const uid = ord.user_id;
        if (!userMetrics[uid]) {
          userMetrics[uid] = {
            total_orders: 0,
            plots: new Set(),
            total_booking_amount: 0,
            total_paid_amount: 0,
            total_pending_amount: 0
          };
        }
        userMetrics[uid].total_orders += 1;
        if (ord.plot_id) userMetrics[uid].plots.add(ord.plot_id);
        const fPrice = Number(ord.final_price || 0);
        const adv = Number(ord.advance_amount || 0);
        const emiPaid = Number(emiPaidMap[ord.booking_id] || 0);
        const paid = adv + emiPaid;

        userMetrics[uid].total_booking_amount += fPrice;
        userMetrics[uid].total_paid_amount += paid;
        userMetrics[uid].total_pending_amount += Math.max(0, fPrice - paid);
      }
    }

    matchedUsers = matchedUsers.map(u => {
      const m = userMetrics[u.user_id] || {
        total_orders: 0,
        plots: new Set(),
        total_booking_amount: 0,
        total_paid_amount: 0,
        total_pending_amount: 0
      };
      return {
        ...u,
        total_plot_orders: m.total_orders,
        total_plots: m.plots instanceof Set ? m.plots.size : 0,
        total_booking_amount: m.total_booking_amount,
        total_paid_amount: m.total_paid_amount,
        total_pending_amount: m.total_pending_amount
      };
    });

    // 3. Resolve Selected User (prefer user with orders or first matched)
    let selectedUser = null;
    if (selected_user_id) {
      selectedUser = matchedUsers.find(u => Number(u.user_id) === Number(selected_user_id)) || null;
      if (!selectedUser) {
        const [singleU] = await sql`
          SELECT user_id, member_id, full_name, mobile_no, email, user_type, account_status 
          FROM users WHERE user_id = ${Number(selected_user_id)}
        `;
        if (singleU) {
          selectedUser = {
            user_id: singleU.user_id,
            member_id: singleU.member_id || `USR-${singleU.user_id}`,
            full_name: singleU.full_name || 'User',
            mobile_no: singleU.mobile_no || '',
            email: singleU.email || '',
            user_type: singleU.user_type,
            account_status: singleU.account_status,
            source_table: 'users',
            total_plot_orders: 0,
            total_plots: 0,
            total_booking_amount: 0,
            total_paid_amount: 0,
            total_pending_amount: 0
          };
        }
      }
    } else if (matchedUsers.length > 0) {
      // Pick first user who has plot orders, or just first user
      selectedUser = matchedUsers.find(u => u.total_plot_orders > 0) || matchedUsers[0];
    }

    // 4. If selected user, fetch their complete Plot Orders and Invoices / Installment History
    let ordersList = [];
    let financialSummary = {
      total_orders: 0,
      total_plots: 0,
      total_invoice_count: 0,
      total_invoice_amount: 0,
      total_paid_amount: 0,
      total_pending_amount: 0,
      paid_installments: 0,
      pending_installments: 0,
      overdue_installments: 0
    };

    if (selectedUser) {
      const fromDateCond = from_date ? sql`AND b.created_at >= ${from_date}::timestamptz` : sql``;
      const toDateCond = to_date ? sql`AND b.created_at <= (${to_date}::date + INTERVAL '1 day')::timestamptz` : sql``;

      const rawBookings = await sql`
        SELECT 
          b.booking_id,
          b.booking_serial,
          COALESCE(b.booking_date, b.created_at) AS booking_date,
          b.booking_status,
          b.payment_type,
          b.payment_method,
          COALESCE(b.advance_amount, 0) AS advance_amount,
          COALESCE(b.remaining_balance, 0) AS remaining_balance,
          p.plot_id,
          p.plot_number,
          p.plot_area,
          p.area_unit,
          s.site_name,
          s.city AS site_city,
          COALESCE(NULLIF(b.base_price, 0), NULLIF(b.requested_price, 0), NULLIF(p.sold_price, 0), NULLIF(p.base_price, 0), (b.advance_amount + b.remaining_balance), 0) AS final_plot_price
        FROM bookings b
        LEFT JOIN plots p ON p.plot_id = b.plot_id
        LEFT JOIN sites s ON s.site_id = p.site_id
        WHERE b.user_id = ${selectedUser.user_id}
          ${fromDateCond}
          ${toDateCond}
        ORDER BY b.created_at ${sort === 'oldest' ? sql`ASC` : sql`DESC`}
      `;

      const bookingIds = rawBookings.map(b => b.booking_id);

      // Invoices
      let invoicesByBooking = {};
      let allInvoices = [];
      if (bookingIds.length > 0) {
        const rawInvoices = await sql`
          SELECT 
            i.invoice_id,
            i.invoice_number,
            i.booking_id,
            COALESCE(i.invoice_date, i.created_at) AS invoice_date,
            COALESCE(i.grand_total, i.subtotal, 0) AS invoice_amount,
            COALESCE(i.paid_amount, 0) AS paid_amount,
            COALESCE(i.balance_amount, 0) AS balance_amount,
            i.payment_status,
            i.payment_method,
            COALESCE(i.order_id, b.booking_serial) AS transaction_id
          FROM invoices i
          LEFT JOIN bookings b ON b.booking_id = i.booking_id
          WHERE i.booking_id IN ${sql(bookingIds)}
          ORDER BY i.invoice_id ASC
        `;
        allInvoices = rawInvoices;
        for (const inv of rawInvoices) {
          if (!invoicesByBooking[inv.booking_id]) invoicesByBooking[inv.booking_id] = [];
          invoicesByBooking[inv.booking_id].push({
            invoice_id: inv.invoice_id,
            invoice_number: inv.invoice_number,
            invoice_date: inv.invoice_date,
            invoice_amount: Number(inv.invoice_amount || 0),
            paid_amount: Number(inv.paid_amount || 0),
            balance_amount: Number(inv.balance_amount || 0),
            payment_status: inv.payment_status || 'Paid',
            payment_method: inv.payment_method || 'Standard',
            transaction_id: inv.transaction_id || `MMR-INV-${inv.invoice_id}`
          });
        }
      }

      // Installments (EMI schedules)
      let emiByBooking = {};
      let allEmiList = [];
      if (bookingIds.length > 0) {
        const rawEmi = await sql`
          SELECT 
            emi_id,
            booking_id,
            installment_no,
            due_date,
            emi_amount,
            COALESCE(paid_amount, 0) AS paid_amount,
            GREATEST(0, emi_amount - COALESCE(paid_amount, 0)) AS pending_amount,
            paid_date,
            emi_status,
            voucher_file_path,
            CASE 
              WHEN LOWER(emi_status) = 'paid' OR (paid_amount >= emi_amount AND emi_amount > 0) THEN 'Paid'
              WHEN paid_amount > 0 AND paid_amount < emi_amount THEN 'Partially Paid'
              WHEN due_date < NOW() AND (paid_amount IS NULL OR paid_amount < emi_amount) THEN 'Overdue'
              ELSE 'Pending'
            END AS computed_status
          FROM emi_schedules
          WHERE booking_id IN ${sql(bookingIds)}
          ORDER BY installment_no ASC
        `;
        allEmiList = rawEmi;
        for (const e of rawEmi) {
          if (!emiByBooking[e.booking_id]) emiByBooking[e.booking_id] = [];
          emiByBooking[e.booking_id].push(e);
        }
      }

      // Build enriched orders
      const userPlots = new Set();
      let grandBookingTotal = 0;
      let grandPaidTotal = 0;
      let grandPendingTotal = 0;

      for (const ord of rawBookings) {
        if (ord.plot_id) userPlots.add(ord.plot_id);
        const finalPrice = Number(ord.final_plot_price || 0);
        const adv = Number(ord.advance_amount || 0);
        const ordInvoices = invoicesByBooking[ord.booking_id] || [];
        const ordEmi = emiByBooking[ord.booking_id] || [];

        // Determine payment type
        const pTypeRaw = String(ord.payment_type || '').toLowerCase();
        const isOneTime = pTypeRaw.includes('full') || pTypeRaw.includes('one') || ordEmi.length === 0;
        const normalizedPaymentType = isOneTime ? 'One-Time' : 'Installment';

        // Filter by payment_type_filter if specified
        if (payment_type_filter === 'One-Time' && !isOneTime) continue;
        if (payment_type_filter === 'Installment' && isOneTime) continue;

        // Calculate paid and pending accurately
        let paidTotal = adv;
        if (!isOneTime) {
          const emiPaidSum = ordEmi.reduce((sum, e) => sum + Number(e.paid_amount || 0), 0);
          paidTotal = adv + emiPaidSum;
        }
        const pendingTotal = Math.max(0, finalPrice - paidTotal);

        grandBookingTotal += finalPrice;
        grandPaidTotal += paidTotal;
        grandPendingTotal += pendingTotal;

        // Filter installments if status_filter is specified
        let filteredInstallments = ordEmi.map(e => ({
          emi_id: e.emi_id,
          installment_no: e.installment_no,
          due_date: e.due_date,
          emi_amount: Number(e.emi_amount || 0),
          paid_amount: Number(e.paid_amount || 0),
          pending_amount: Number(e.pending_amount || 0),
          paid_date: e.paid_date,
          payment_status: e.computed_status,
          invoice_number: ordInvoices[0]?.invoice_number || null,
          transaction_id: ord.booking_serial || `ORD-${ord.booking_id}`
        }));

        if (status_filter && status_filter !== 'All') {
          filteredInstallments = filteredInstallments.filter(e => e.payment_status.toLowerCase() === status_filter.toLowerCase());
        }

        ordersList.push({
          booking_id: ord.booking_id,
          booking_serial: ord.booking_serial || `MMR-ORD-${ord.booking_id}`,
          site_name: ord.site_name || 'MMR Site',
          plot_number: ord.plot_number ? String(ord.plot_number) : 'N/A',
          plot_area: ord.plot_area ? `${ord.plot_area} ${ord.area_unit || 'Gaj'}` : '',
          booking_date: ord.booking_date,
          final_plot_price: finalPrice,
          payment_type: normalizedPaymentType,
          total_amount: finalPrice,
          paid_amount: paidTotal,
          pending_amount: pendingTotal,
          booking_status: ord.booking_status || 'Submitted',
          invoices: ordInvoices,
          installments: filteredInstallments,
          total_installments_count: ordEmi.length
        });
      }

      // Financial Summary metrics
      let paidEmiCount = 0;
      let pendingEmiCount = 0;
      let overdueEmiCount = 0;

      for (const e of allEmiList) {
        if (e.computed_status === 'Paid') paidEmiCount++;
        else if (e.computed_status === 'Overdue') overdueEmiCount++;
        else pendingEmiCount++;
      }

      const totalInvoiceAmt = allInvoices.reduce((sum, inv) => sum + Number(inv.invoice_amount || 0), 0);

      financialSummary = {
        total_orders: rawBookings.length,
        total_plots: userPlots.size,
        total_invoice_count: allInvoices.length,
        total_invoice_amount: totalInvoiceAmt,
        total_paid_amount: grandPaidTotal,
        total_pending_amount: grandPendingTotal,
        paid_installments: paidEmiCount,
        pending_installments: pendingEmiCount,
        overdue_installments: overdueEmiCount
      };
    }

    return ok(res, {
      users: matchedUsers,
      selected_user: selectedUser,
      orders: ordersList,
      financial_summary: financialSummary
    }, 'Search invoices data loaded successfully');

  } catch (e) {
    console.error('[search-invoices] error:', e);
    return err(res, e.message || 'Failed to search invoices', 500);
  }
});

/**
 * 2. GET /api/admin/plot-orders/:id
 * Get full detailed specs for a single plot booking order (Admin Master View).
 */
router.get('/admin/plot-orders/:id', verifyAdminToken, async (req, res) => {
  const bookingId = Number(req.params.id);
  if (!bookingId || bookingId <= 0) return err(res, 'Invalid booking ID', 400);
  return executePlotOrderDetailQuery(req, res, bookingId, sql`TRUE`);
});

/**
 * User / Portal Plot Orders Endpoints (Team Member, Associate, Customer)
 * 3. GET /api/user/plot-orders
 */
router.get('/user/plot-orders', verifyUserToken, async (req, res) => {
  const scope = await resolvePlotOrderScope(req);
  if (scope.error) return err(res, scope.error, scope.status);
  return executePlotOrdersQuery(req, res, scope.scopeFilter, { user_role: scope.role });
});

/**
 * 4. GET /api/user/plot-orders/:id
 */
router.get('/user/plot-orders/:id', verifyUserToken, async (req, res) => {
  const bookingId = Number(req.params.id);
  if (!bookingId || bookingId <= 0) return err(res, 'Invalid booking ID', 400);
  const scope = await resolvePlotOrderScope(req);
  if (scope.error) return err(res, scope.error, scope.status);
  return executePlotOrderDetailQuery(req, res, bookingId, scope.scopeFilter);
});

/**
 * 5. POST /api/user/plot-orders/:id/generate-invoice
 */
router.post('/user/plot-orders/:id/generate-invoice', verifyUserToken, async (req, res) => {
  try {
    const bookingId = Number(req.params.id);
    if (!bookingId || bookingId <= 0) return err(res, 'Invalid booking ID', 400);
    const scope = await resolvePlotOrderScope(req);
    if (scope.error) return err(res, scope.error, scope.status);

    // Verify booking is within caller's scope
    const [allowed] = await sql`
      SELECT booking_id FROM bookings b WHERE b.booking_id = ${bookingId} AND ${scope.scopeFilter} LIMIT 1
    `;
    if (!allowed) {
      return err(res, 'Booking order not found or access unauthorized', 404);
    }

    const invoice = await createOrGetInvoice(bookingId);
    return ok(res, { invoice }, 'Invoice generated successfully');
  } catch (e) {
    console.error('[UserPlotOrders] Error generating invoice:', e);
    return err(res, e.message || 'Failed to generate invoice', 500);
  }
});

/**
 * 3. PATCH /api/admin/plot-orders/:id/status
 * Direct approval or rejection from Admin Panel with full status consistency.
 * 
 * Rules:
 * - If status is 'Confirmed' or 'Approved':
 *   - Booking is marked 'Confirmed'
 *   - Plot is set to 'Sold' (or 'Booked')
 *   - Associate approval status is set to 'Approved'
 *   - Self-Purchase check: If buyer is buying for self, 0% commission is enforced!
 *     Commission is skipped with a clear record in logs.
 * - If status is 'Rejected':
 *   - Booking status marked 'Rejected'
 *   - Plot status reverted to 'Vacant'
 */
router.patch('/admin/plot-orders/:id/status', verifyAdminToken, role('SuperAdmin', 'Admin', 'FinanceManager'), async (req, res) => {
  try {
    const bookingId = Number(req.params.id);
    const { status, reason, remarks } = req.body || {};

    if (!bookingId || bookingId <= 0) return err(res, 'Invalid booking ID', 400);
    if (!status || !['Confirmed', 'Approved', 'Rejected', 'Pending', 'Under Process', 'Submitted', 'Choose'].includes(status)) {
      return err(res, "Status must be 'Confirmed'/'Approved', 'Rejected', 'Pending', 'Under Process', or 'Submitted'", 400);
    }

    const adminId = req.admin?.admin_id || req.user?.admin_id || 1;
    const adminName = req.admin?.username || req.admin?.full_name || 'Admin';

    const [booking] = await sql`
      SELECT b.*, p.plot_id, p.plot_status, p.site_id,
             (COALESCE(buyer.user_type, 'Customer') != 'Customer' AND (b.booking_type = 'SELF_PURCHASE' OR b.user_id = b.sold_by_user_id)) AS is_self_purchase
      FROM bookings b
      LEFT JOIN plots p ON p.plot_id = b.plot_id
      LEFT JOIN users buyer ON buyer.user_id = b.user_id
      WHERE b.booking_id = ${bookingId}
    `;

    if (!booking) return err(res, 'Booking order not found', 404);

    const isApprove = (status === 'Confirmed' || status === 'Approved');
    const isReject = (status === 'Rejected');
    const effectiveStatus = isApprove ? 'Confirmed' : (isReject ? 'Rejected' : status);

    const cleanRemarks = remarks ? String(remarks).trim() : (reason ? String(reason).trim() : '');
    const cleanReason = reason ? String(reason).trim() : (remarks ? String(remarks).trim() : '');

    let updatedOrder = null;

    if (isApprove) {
      const notesApprove = cleanRemarks
        ? sql`CONCAT(COALESCE(notes, ''), ' | Admin Note: ', ${cleanRemarks}::text)`
        : sql`notes`;

      // 1. Mark booking confirmed and associate approval approved
      [updatedOrder] = await sql`
        UPDATE bookings
        SET
          booking_status = 'Confirmed',
          associate_approval_status = 'Approved',
          confirmed_at = COALESCE(confirmed_at, NOW()),
          notes = ${notesApprove}
        WHERE booking_id = ${bookingId}
        RETURNING *
      `;

      // 2. Update plot status to Sold or Booked
      if (booking.plot_id) {
        await sql`
          UPDATE plots
          SET plot_status = 'Sold', sold_at = COALESCE(sold_at, NOW()), updated_at = NOW()
          WHERE plot_id = ${booking.plot_id}
        `.catch(() => {});

        // Log plot status history
        await sql`
          INSERT INTO plot_status_history (plot_id, old_status, new_status, changed_by_user_id, admin_name, remarks)
          VALUES (${booking.plot_id}, ${booking.plot_status || 'Vacant'}, 'Sold', ${adminId}, ${adminName}, ${cleanRemarks || 'Approved by Admin in Plot Orders'}::text)
        `.catch(() => {});
      }

      // 3. Task 7: Ensure EMI schedules exist for EMI orders (No invoices at approval)
      if (booking.payment_type === 'EMI') {
        try {
          const { ensureEmiSchedulesForBooking } = await import('../services/emi.service.js');
          await ensureEmiSchedulesForBooking(sql, booking);
        } catch (emiErr) {
          console.error('[AdminPlotOrders] EMI schedule generation notice:', emiErr.message);
        }
      }

      // 4. Commission check:
      // USER RULE: "कस्टमर अपने सेल्फ के लिए लगाता है, तो फिर उसमें ना ही किसी तरह का कमीशन होगा और ना ही कोई पेमेंट कटेगा। ये पूरा का पूरा जो पेमेंट होगा, इसका जो कस्टमर, जो टीम मेंबर है, ये जो भी ओनर है टीम मेंबर, ये उसको देगा।"
      if (booking.is_self_purchase || booking.booking_type === 'SELF_PURCHASE' || booking.user_id === booking.sold_by_user_id) {
        console.log(`[AdminPlotOrders] Booking #${bookingId} is SELF_PURCHASE by Member #${booking.user_id}. Commission is strictly 0%.`);
      } else {
        // Standard sale: trigger commission calculation if advance amount > 0
        if (Number(booking.advance_amount) > 0 && booking.sold_by_user_id) {
          try {
            await commissionService.generateCommissionForPayment({
              bookingId,
              event: {
                type: 'BookingAdvance',
                sourceRef: `adv-${bookingId}`,
                receivedAmount: Number(booking.advance_amount),
                paymentType: booking.payment_type || 'Standard'
              },
              adminId
            });
          } catch (commErr) {
            console.error('[AdminPlotOrders] Commission generation notice:', commErr.message);
          }
        }
      }

    } else if (isReject) {
      const notesReject = cleanReason
        ? sql`CONCAT(COALESCE(notes, ''), ' | Rejection Reason: ', ${cleanReason}::text)`
        : sql`notes`;

      // 1. Mark booking rejected
      [updatedOrder] = await sql`
        UPDATE bookings
        SET
          booking_status = 'Rejected',
          associate_approval_status = 'Rejected',
          associate_rejection_reason = ${cleanReason || 'Rejected by Admin'}::text,
          notes = ${notesReject}
        WHERE booking_id = ${bookingId}
        RETURNING *
      `;

      // 2. Revert plot to Vacant
      if (booking.plot_id) {
        await sql`
          UPDATE plots
          SET plot_status = 'Vacant', updated_at = NOW()
          WHERE plot_id = ${booking.plot_id}
        `.catch(() => {});

        // Release locks if any
        await sql`
          UPDATE plot_booking_locks
          SET status = 'Expired', updated_at = NOW()
          WHERE plot_id = ${booking.plot_id} AND status = 'Active'
        `.catch(() => {});

        await sql`
          INSERT INTO plot_status_history (plot_id, old_status, new_status, changed_by_user_id, admin_name, remarks)
          VALUES (${booking.plot_id}, ${booking.plot_status || 'InProcess'}, 'Vacant', ${adminId}, ${adminName}, ${cleanReason || 'Rejected by Admin in Plot Orders'}::text)
        `.catch(() => {});
      }
    } else if (status === 'Submitted' || status === 'Choose') {
      const notesReset = cleanRemarks
        ? sql`CONCAT(COALESCE(notes, ''), ' | Status Reset: ', ${cleanRemarks}::text)`
        : sql`notes`;

      [updatedOrder] = await sql`
        UPDATE bookings
        SET
          booking_status = 'Submitted',
          associate_approval_status = 'Pending',
          confirmed_at = NULL,
          notes = ${notesReset}
        WHERE booking_id = ${bookingId}
        RETURNING *
      `;

      if (booking.plot_id && booking.plot_status === 'Sold') {
        await sql`UPDATE plots SET plot_status = 'Vacant', updated_at = NOW() WHERE plot_id = ${booking.plot_id}`.catch(() => {});
        await sql`
          INSERT INTO plot_status_history (plot_id, old_status, new_status, changed_by_user_id, admin_name, remarks)
          VALUES (${booking.plot_id}, 'Sold', 'Vacant', ${adminId}, ${adminName}, 'Status reset to unreviewed')
        `.catch(() => {});
      }
    } else {
      const notesDirect = cleanRemarks
        ? sql`CONCAT(COALESCE(notes, ''), ' | Status Update: ', ${cleanRemarks}::text)`
        : sql`notes`;

      // Direct status update (Pending / Under Process)
      [updatedOrder] = await sql`
        UPDATE bookings
        SET
          booking_status = ${effectiveStatus},
          notes = ${notesDirect}
        WHERE booking_id = ${bookingId}
        RETURNING *
      `;
    }

    return ok(res, {
      booking_id: bookingId,
      status: effectiveStatus,
      is_self_purchase: Boolean(booking.is_self_purchase),
      order: updatedOrder
    }, `Booking order status updated to ${effectiveStatus} successfully`);

  } catch (e) {
    console.error('[AdminPlotOrders] Error updating status:', e);
    return err(res, e.message || 'Failed to update booking order status', 500);
  }
});

/**
 * 4. POST /api/admin/plot-orders/:id/generate-invoice
 * Generates an invoice for an order if not already present.
 */
router.post('/admin/plot-orders/:id/generate-invoice', verifyAdminToken, async (req, res) => {
  try {
    const bookingId = Number(req.params.id);
    if (!bookingId || bookingId <= 0) return err(res, 'Invalid booking ID', 400);

    const invoice = await createOrGetInvoice(bookingId);
    return ok(res, { invoice }, 'Invoice generated successfully');
  } catch (e) {
    console.error('[AdminPlotOrders] Error generating invoice:', e);
    return err(res, e.message || 'Failed to generate invoice', 500);
  }
});

/**
 * 5. GET /api/admin/plot-orders/search-invoices
 * Comprehensive Search Invoices API across Customer, Associate, and Investor.
 * Supports partial name, exact ID, mobile, and email search.
 * Returns full Plot Order history, invoices, installment breakdown, and non-duplicate financial summaries.
 */

export default router;
