# Admin-First Workflow - Alma Lifestyle Ecommerce

**Version**: 1.0 | **Core Principle**: Build complete admin system first, then customer UI  
**Development Priority**: APIs and admin operations before customer experience

---

## Philosophy: Admin-First Development

### Why Admin-First?
```
Traditional Approach:
✗ Build beautiful frontend
✗ Realize backend doesn't exist
✗ Build APIs hastily to match UI
✗ Poor API design, inconsistent patterns
✗ Frontend breaks when backend changes

Admin-First Approach:
✓ Design complete API surface
✓ Implement all business logic server-side
✓ Build admin dashboard using APIs
✓ Test APIs thoroughly
✓ Customer UI uses same proven APIs
✓ Consistent, stable, scalable
```

### Benefits
1. **APIs are proven** - Admin tests all endpoints first
2. **Business logic centralized** - One place to fix bugs
3. **Admin tools powerful** - Can do bulk operations
4. **Customer UI is simple** - Just calls proven APIs
5. **Easier scaling** - Multiple UIs can use same APIs

---

## Admin Workflow Overview

```
Phase 1: Authentication & Setup
├── Admin login created
├── Authentication endpoints secured
├── Database configured
└── Admin user created

Phase 2: Product Management
├── Create/edit/delete products via API
├── Upload images (batch)
├── Organize into categories
├── Create collections
└── Publish/unpublish products

Phase 3: Bulk Import
├── Configure import sources (URLs, CSV)
├── Run imports (progress tracked)
├── Review results
├── Fix errors
└── Publish imported products

Phase 4: Order Management
├── View incoming orders
├── Update order status
├── Send notifications
├── Handle customer service
└── Generate invoices

Phase 5: Analytics & Reporting
├── View sales dashboard
├── Track inventory levels
├── Analyze customer behavior
├── Generate reports
└── Make data-driven decisions
```

---

## Admin User Lifecycle

### 1. Admin Registration & Authentication

```
CREATE ADMIN USER:
POST /api/v1/auth/admin/register
{
  "email": "admin@almalifestyle.com",
  "password": "SecurePassword123!",
  "name": "Fatima Manager"
}

Response:
{
  "status": "success",
  "data": {
    "id": "admin_123",
    "email": "admin@almalifestyle.com",
    "name": "Fatima Manager",
    "role": "admin",
    "createdAt": "2026-05-14T..."
  }
}

ADMIN LOGIN:
POST /api/v1/auth/admin/login
{
  "email": "admin@almalifestyle.com",
  "password": "SecurePassword123!"
}

Response:
{
  "status": "success",
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIs...",
    "refreshToken": "eyJhbGciOiJIUzI1NiIs...",
    "expiresIn": 3600,
    "admin": {
      "id": "admin_123",
      "email": "admin@almalifestyle.com",
      "role": "admin"
    }
  }
}

Note: All subsequent requests include Authorization header:
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

### 2. Admin Permission Levels

```
SUPER_ADMIN
├── Can do everything
├── Can create other admins
├── Can delete products/orders
├── Can access audit logs
└── Can change system settings

ADMIN
├── Can manage products
├── Can manage collections
├── Can manage orders
├── Can run imports
├── Can view analytics
└── Cannot delete admins or system settings

MODERATOR
├── Can edit products
├── Can update order status
├── Can manage categories
├── Can view orders
└── Cannot create/delete products or collections

VIEWER
├── Can view products
├── Can view orders
├── Can view analytics
└── Cannot edit anything
```

---

## Product Management Workflow

### Adding New Products

#### Option A: Create Single Product
```
POST /api/v1/admin/products
{
  "title": "Premium Embroidered Kurti",
  "categoryId": "cat_123",
  "sku": "ALM-KURTI-EMBO-001",
  "price": 79.99,
  "description": "Elegant kurti with hand embroidery",
  "fabric": "Cotton with silk embroidery",
  "careInstructions": "Hand wash, dry in shade",
  "originCountry": "IN",
  "weight": 0.5
}

Response:
{
  "status": "success",
  "data": {
    "id": "prod_456",
    "title": "Premium Embroidered Kurti",
    "sku": "ALM-KURTI-EMBO-001",
    "slug": "premium-embroidered-kurti",
    "status": "draft",
    "createdAt": "2026-05-14T..."
  }
}
```

#### Option B: Bulk Import from URL
```
POST /api/v1/admin/products/import
{
  "sourceType": "url",
  "sourceUrl": "https://supplier.example.com/api/products",
  "categoryId": "cat_123",
  "autoPublish": false,
  "mapping": {
    "title": "title",
    "price": "price_usd",
    "description": "description",
    "imageUrl": "image"
  }
}

Response:
{
  "status": "success",
  "data": {
    "batchId": "imp_789",
    "status": "processing",
    "progress": { "completed": 0, "total": 150, "errors": 0 },
    "eta": "5 minutes"
  }
}

CHECK PROGRESS:
GET /api/v1/admin/products/import/imp_789

Response:
{
  "status": "success",
  "data": {
    "batchId": "imp_789",
    "status": "processing",
    "progress": { "completed": 45, "total": 150, "errors": 2 },
    "eta": "3 minutes",
    "logs": [
      { "product": "SKU001", "status": "ok", "id": "prod_123" },
      { "product": "SKU002", "status": "error", "reason": "price_missing" },
      { "product": "SKU003", "status": "ok", "id": "prod_124" }
    ]
  }
}
```

### Editing Products

```
GET /api/v1/admin/products/prod_456
↓ (loads product details into form)
↓ (admin makes edits)
PATCH /api/v1/admin/products/prod_456
{
  "title": "Premium Embroidered Kurti - Updated",
  "price": 89.99,
  "description": "New description"
}

Audit logged automatically:
{
  "entityType": "product",
  "entityId": "prod_456",
  "action": "update",
  "oldValues": { "title": "...", "price": 79.99 },
  "newValues": { "title": "...", "price": 89.99 },
  "adminId": "admin_123",
  "timestamp": "2026-05-14T14:30:00Z"
}
```

### Uploading Product Images

```
POST /api/v1/admin/products/prod_456/images
{
  "files": [File1, File2, File3],
  "alt": ["Front view", "Side view", "Detail"]
}

Processing:
1. Validate files (JPEG/PNG, <50MB each)
2. Download original
3. Generate thumbnails (150x200, 300x400, 600x800, 1200x1600)
4. Optimize (compression, progressive)
5. Upload to Supabase Storage
6. Store URLs in database
7. Return CDN URLs

Response:
{
  "status": "success",
  "data": {
    "images": [
      {
        "id": "img_001",
        "productId": "prod_456",
        "url": "https://cdn.almalifestyle.com/products/prod_456/image_1.jpg",
        "thumbnail": "https://cdn.almalifestyle.com/products/prod_456/thumb_1.jpg",
        "alt": "Front view",
        "sortOrder": 0
      }
    ]
  }
}
```

### Managing Variants (Sizes/Colors)

```
POST /api/v1/admin/products/prod_456/variants
{
  "size": "M",
  "color": "Black",
  "sku": "ALM-KURTI-EMBO-001-M-BLK",
  "stockQuantity": 50
}

Response:
{
  "status": "success",
  "data": {
    "id": "var_789",
    "productId": "prod_456",
    "size": "M",
    "color": "Black",
    "sku": "ALM-KURTI-EMBO-001-M-BLK",
    "stockQuantity": 50,
    "reservedQuantity": 0
  }
}

UPDATE STOCK:
PATCH /api/v1/admin/products/prod_456/variants/var_789
{
  "stockQuantity": 45,
  "reason": "Physical inventory adjustment"
}

Note: Audit logged with reason for traceability
```

### Publishing/Unpublishing Products

```
POST /api/v1/admin/products/prod_456/publish
{ "publish": true }

Response:
{
  "status": "success",
  "data": {
    "id": "prod_456",
    "published": true,
    "publishedAt": "2026-05-14T14:35:00Z"
  }
}

After publishing:
- Product appears in public API /api/v1/products
- Product appears on shop homepage/catalog
- Product is searchable

After unpublishing:
- Product removed from public API
- Product hidden from shop
- Admin can still edit it
```

---

## Collection Management

### Create Collection
```
POST /api/v1/admin/collections
{
  "name": "Summer Essentials",
  "slug": "summer-essentials",
  "description": "Perfect pieces for summer style",
  "heroImage": "https://...",
  "published": true
}

Response:
{
  "status": "success",
  "data": {
    "id": "col_111",
    "name": "Summer Essentials",
    "slug": "summer-essentials",
    "productCount": 0,
    "published": true
  }
}
```

### Add Products to Collection
```
POST /api/v1/admin/collections/col_111/products
{
  "productIds": ["prod_456", "prod_789", "prod_111"],
  "sortOrder": "manual"
}

Response: { "status": "success", "data": { "productCount": 3 } }

REORDER PRODUCTS IN COLLECTION:
PATCH /api/v1/admin/collections/col_111/products
{
  "productId": "prod_456",
  "newPosition": 0
}
```

---

## Order Management

### Viewing Orders

```
GET /api/v1/admin/orders
?status=pending_payment
&sortBy=createdAt
&sortOrder=desc
&page=1
&limit=20

Response:
{
  "status": "success",
  "data": {
    "orders": [
      {
        "id": "ord_999",
        "orderNumber": "ALM-20260514-001",
        "customerName": "Fatima Ahmed",
        "customerPhone": "+971501234567",
        "status": "pending_payment",
        "total": 330.00,
        "itemCount": 2,
        "createdAt": "2026-05-14T10:00:00Z"
      }
    ],
    "pagination": { "page": 1, "limit": 20, "total": 45 }
  }
}

GET /api/v1/admin/orders/ord_999
Response: Full order details with items, addresses, timeline
```

### Updating Order Status

```
PATCH /api/v1/admin/orders/ord_999/status
{
  "status": "confirmed",
  "note": "Payment verified",
  "notifyCustomer": true
}

Valid status transitions:
pending_payment → confirmed → shipped → delivered
pending_payment → cancelled

Audit logged:
{
  "entityType": "order",
  "entityId": "ord_999",
  "action": "status_update",
  "oldValues": { "status": "pending_payment" },
  "newValues": { "status": "confirmed" },
  "adminId": "admin_123"
}

If notifyCustomer=true:
- WhatsApp message sent to customer
- Email sent to customer
- Notification logged
```

### Tracking & Shipping

```
PATCH /api/v1/admin/orders/ord_999
{
  "status": "shipped",
  "trackingNumber": "TRK123456789",
  "carrier": "DHL",
  "estimatedDelivery": "2026-05-18"
}

Response: Updated order with tracking info

Customer can now track at: /orders/ALM-20260514-001/track
```

---

## Analytics Dashboard

### Dashboard Overview
```
GET /api/v1/admin/analytics/dashboard
?dateRange=30d

Response:
{
  "status": "success",
  "data": {
    "metrics": {
      "totalRevenue": 5250.00,
      "totalOrders": 45,
      "totalCustomers": 32,
      "avgOrderValue": 116.67,
      "conversionRate": 3.2,
      "returnCustomerRate": 25.0
    },
    "topProducts": [
      { "title": "Premium Kurti", "soldCount": 12, "revenue": 950.00 },
      { "title": "Saree", "soldCount": 8, "revenue": 720.00 }
    ],
    "ordersByDay": [
      { "date": "2026-05-14", "orders": 5, "revenue": 580.00 },
      { "date": "2026-05-13", "orders": 3, "revenue": 350.00 }
    ],
    "customersByCountry": [
      { "country": "AE", "count": 20, "revenue": 2500.00 },
      { "country": "BD", "count": 12, "revenue": 1200.00 }
    ]
  }
}
```

### Inventory Alerts
```
GET /api/v1/admin/analytics/inventory-alerts

Response:
{
  "status": "success",
  "data": {
    "lowStock": [
      {
        "productId": "prod_456",
        "title": "Premium Kurti",
        "variant": "M / Black",
        "currentStock": 3,
        "threshold": 10
      }
    ],
    "outOfStock": [
      {
        "productId": "prod_789",
        "title": "Silk Saree",
        "variant": "One Size / Blue"
      }
    ]
  }
}
```

---

## Audit & Compliance

### Audit Log Viewing
```
GET /api/v1/admin/audit-logs
?entityType=product
&dateRange=7d
&adminId=admin_123

Response:
{
  "status": "success",
  "data": {
    "logs": [
      {
        "id": "log_123",
        "timestamp": "2026-05-14T14:30:00Z",
        "adminId": "admin_123",
        "adminName": "Fatima Manager",
        "entityType": "product",
        "entityId": "prod_456",
        "action": "update",
        "oldValues": { "price": 79.99 },
        "newValues": { "price": 89.99 },
        "ipAddress": "192.168.1.1",
        "userAgent": "Mozilla/5.0..."
      }
    ]
  }
}
```

---

## Admin Dashboard Features

### Must-Have Pages

| Page | Purpose | Key Features |
|------|---------|--------------|
| **Dashboard** | Overview | Stats, charts, alerts, quick actions |
| **Products** | Product list | Search, filter, bulk edit, quick preview |
| **Product Editor** | Create/edit | Form validation, image upload, variants, preview |
| **Categories** | Organize | Tree view, drag-to-reorder, create/edit |
| **Collections** | Curated groups | Drag products to order, publish/unpublish |
| **Import Tool** | Bulk add | Source setup, preview, progress tracking |
| **Orders** | Order list | Filter by status, search, bulk actions |
| **Order Detail** | Order view | Timeline, update status, send notifications |
| **Analytics** | Reports | Charts, metrics, trends, exports |
| **Customers** | Customer list | View profile, order history, contact |
| **Audit Log** | Compliance | Filter, export, search all changes |
| **Settings** | Config | Brand info, team members, integration keys |

### Smart UI Features

```
✓ Bulk operations (select multiple, bulk edit status/price/category)
✓ Quick edit (click to edit inline for simple fields)
✓ Search (full-text product search across all fields)
✓ Filters (by category, status, price range, date range)
✓ Sorting (by name, price, date, popularity)
✓ Keyboard shortcuts (Cmd+S to save, Cmd+K for command palette)
✓ Undo/redo (for supported operations)
✓ Dark mode (optional, toggleable)
✓ Responsive (works on tablets too)
✓ Notifications (toasts for success/error/info)
✓ Modals (confirm dangerous actions)
✓ Loading states (clear feedback during processing)
```

---

## Data Entry Validation

### Product Validation Rules

```typescript
interface ProductValidation {
  title: {
    required: true,
    minLength: 5,
    maxLength: 255,
    unique: false
  },
  sku: {
    required: true,
    pattern: /^[A-Z0-9\-]+$/,
    unique: true   // Per brand
  },
  price: {
    required: true,
    type: "number",
    min: 0.01,
    max: 99999.99
  },
  category: {
    required: true,
    type: "uuid"
  },
  images: {
    required: true,
    minItems: 1,
    acceptedFormats: ["jpg", "jpeg", "png", "webp"],
    maxFileSize: 52428800  // 50MB
  }
}
```

---

## Batch Operations

### Bulk Price Update
```
POST /api/v1/admin/bulk-operations/update-price
{
  "productIds": ["prod_456", "prod_789", "prod_111"],
  "newPrice": 99.99,
  "reason": "Summer sale"
}

Audit logged for each product update
```

### Bulk Inventory Adjustment
```
POST /api/v1/admin/bulk-operations/adjust-inventory
{
  "adjustments": [
    { "variantId": "var_123", "quantity": -5, "reason": "Shrinkage" },
    { "variantId": "var_124", "quantity": +10, "reason": "Restocking" }
  ]
}
```

---

## Integration Hooks

### When Admin Creates Product
```
1. Validate input
2. Create product record
3. Log to audit_logs
4. Upload images (async)
5. Generate slug and SEO meta
6. Cache invalidation (if published)
7. Return success response
```

### When Admin Changes Order Status to "shipped"
```
1. Validate status transition
2. Update order status
3. Log to audit_logs
4. Send WhatsApp notification (async)
5. Send email notification (async)
6. Update customer portal
7. Return success response
```

---

## Performance Considerations

### Admin Dashboard Optimization
```
✓ Pagination on all lists (default 20 items)
✓ Virtual scrolling for large lists
✓ Search debouncing (300ms)
✓ Lazy loading images
✓ Code splitting (admin routes separate)
✓ Caching frequently accessed data
✓ Optimistic UI updates (show change immediately)
✓ Batch request debouncing
```

### API Performance
```
✓ Database indexes on all common queries
✓ Query result caching (products, collections)
✓ Async background jobs (image processing, imports)
✓ Rate limiting (10000 req/min for admin)
✓ Connection pooling
✓ Query optimization (no N+1 queries)
```

---

## Security Best Practices

### Admin Endpoints
```
✓ All /api/v1/admin/* routes require authentication
✓ JWT tokens in Authorization header
✓ CSRF tokens for state-changing requests
✓ Rate limiting (stricter for sensitive operations)
✓ IP whitelisting (optional for super admin)
✓ 2FA support (TOTP ready)
✓ Session timeout after 1 hour of inactivity
✓ All operations logged to audit_logs
✓ PII encrypted at rest
```

### Admin Password Requirements
```
✓ Minimum 12 characters
✓ At least 1 uppercase letter
✓ At least 1 lowercase letter
✓ At least 1 digit
✓ At least 1 special character
✓ No dictionary words
✓ No personal info (name, email)
✓ Password reset every 90 days (optional)
```

---

## Operational Runbooks

### Daily Operations Checklist
```
□ Check analytics dashboard (sales, orders)
□ Review audit log for any suspicious activity
□ Check inventory alerts (low stock items)
□ Process any pending orders
□ Respond to customer inquiries
□ Verify all imports completed successfully
```

### Weekly Operations Checklist
```
□ Review top-selling products
□ Check conversion rate and abandonment rate
□ Review customer feedback (WhatsApp messages)
□ Backup database manually (in addition to automatic)
□ Check error logs for issues
□ Review performance metrics
```

### Monthly Operations Checklist
```
□ Analyze sales trends
□ Plan upcoming collections/promotions
□ Review and update product descriptions
□ Check for products needing restock
□ Generate monthly report
□ Review admin team activity (audit log)
```

---

*Admin workflow maintained in: `/ADMIN_WORKFLOW.md`*  
*Version 1.0 | Last Updated: May 2026*
