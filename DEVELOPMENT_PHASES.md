# Development Phases - Alma Lifestyle Ecommerce

**Timeline**: 16 weeks | **Approach**: Admin-first, API-first, test-driven  
**Success Criteria**: Each phase must have 100% test coverage for APIs before UI work

---

## Overview

```
Phase 1 (Weeks 1-2):   Foundation & Database
Phase 2 (Weeks 3-5):   Admin APIs & Dashboard
Phase 3 (Weeks 6-8):   Product Import System
Phase 4 (Weeks 9-11):  Order Management & Cart
Phase 5 (Weeks 12-14): Customer Frontend
Phase 6 (Weeks 15-16): Launch & Optimization
```

---

## Phase 1: Foundation & Database (Weeks 1-2)

### Goals
- ✓ Database schema finalized and deployed
- ✓ Authentication system ready (admin, customer)
- ✓ API structure and patterns established
- ✓ Development environment configured
- ✓ CI/CD pipeline working

### Deliverables

#### 1.1 Database Setup
```
Tasks:
- [ ] Create Supabase project (production + staging)
- [ ] Deploy full schema (DATABASE_SCHEMA.md)
- [ ] Set up RLS (Row Level Security) policies
- [ ] Configure backups & monitoring
- [ ] Create seed data for 3 categories
- [ ] Test all indexes and constraints

Acceptance:
- All tables created and queryable
- RLS policies prevent unauthorized access
- Backups running on schedule
```

#### 1.2 Authentication System
```
Admin Authentication:
- [ ] Admin signup (email + password)
- [ ] Admin login (JWT token + session)
- [ ] Logout (token invalidation)
- [ ] Password reset (email link)
- [ ] 2FA setup (TOTP ready, not required yet)

Customer Authentication:
- [ ] Customer signup (email verification)
- [ ] Customer login/logout
- [ ] Auto-login after purchase
- [ ] Session persistence

Tests:
- [ ] 95+ test cases for auth flows
- [ ] Invalid credentials rejected
- [ ] Tokens expire correctly
- [ ] XSS/CSRF protected
```

#### 1.3 API Foundation
```
Structure:
- /api/v1/health           (status check)
- /api/v1/auth/*           (auth endpoints)
- /api/v1/admin/*          (admin operations)
- /api/v1/products         (public read)
- /api/v1/orders           (order operations)

Patterns Established:
- [ ] Error handling standard (status, code, message, details)
- [ ] Request validation (Zod schemas)
- [ ] Rate limiting (1000 req/min customer, 10000 admin)
- [ ] Logging (all requests, auth events, errors)
- [ ] CORS configured

Documentation:
- [ ] OpenAPI/Swagger spec generated
- [ ] Postman collection created
- [ ] Error codes documented
- [ ] Rate limit headers tested
```

#### 1.4 CI/CD Pipeline
```
GitHub Actions:
- [ ] Lint on push (eslint, TypeScript strict)
- [ ] Tests on push (Jest, >80% coverage)
- [ ] Type checking on push (tsc --noEmit)
- [ ] Staging deploy on PR merge
- [ ] Production deploy on release tag

Status Checks:
- [ ] All must pass before merge
- [ ] Performance budget (JS < 500kb gzipped)
- [ ] Lighthouse score > 90 required
```

### Definition of Done
- [ ] All database tables created and tested
- [ ] Admin can authenticate and get JWT token
- [ ] Customer can register and verify email
- [ ] All APIs return correct error formats
- [ ] Postman collection works end-to-end
- [ ] CI/CD deploys to staging automatically

### Budget: 40 hours

---

## Phase 2: Admin APIs & Dashboard (Weeks 3-5)

### Goals
- ✓ Complete admin API surface for products, categories, collections
- ✓ Admin dashboard UI for all operations
- ✓ Admin can CRUD everything
- ✓ Audit logging for all changes
- ✓ All operations reversible (soft deletes, undo)

### Deliverables

#### 2.1 Product Management APIs
```
Endpoints:
- GET    /api/v1/admin/products              (paginated list)
- POST   /api/v1/admin/products              (create)
- GET    /api/v1/admin/products/{id}         (read)
- PATCH  /api/v1/admin/products/{id}         (update)
- DELETE /api/v1/admin/products/{id}         (soft delete)
- POST   /api/v1/admin/products/{id}/publish (publish/unpublish)
- POST   /api/v1/admin/products/{id}/variants (manage variants)
- POST   /api/v1/admin/products/{id}/images  (upload images)

Tests:
- [ ] Create product with valid data
- [ ] Reject product without category
- [ ] Reject duplicate SKU
- [ ] Update product fields
- [ ] Soft delete and restore
- [ ] Publishing changes published_at
- [ ] Unpublishing removes from public API
- [ ] Image upload resizes and caches
- [ ] Concurrent updates handled safely
```

#### 2.2 Category & Collection APIs
```
Endpoints:
- GET/POST/PATCH/DELETE /api/v1/admin/categories
- GET/POST/PATCH/DELETE /api/v1/admin/collections
- POST /api/v1/admin/collections/{id}/products (add/remove products)

Tests:
- [ ] Category hierarchy (parent-child)
- [ ] Collection ordering preserved
- [ ] Cannot delete category with products
- [ ] Moving products between collections works
- [ ] Category slug is unique per brand
```

#### 2.3 Audit Logging
```
Auto-logged Operations:
- [ ] Every product create/update/delete
- [ ] Every category create/update/delete
- [ ] Every collection modification
- [ ] Every import operation
- [ ] Every order status change
- [ ] Every admin login/logout

Audit Log Fields:
- admin_id, admin_ip, user_agent
- entity_type, entity_id, action
- old_values, new_values (before/after)
- timestamp

Access:
- [ ] Admin can view audit log
- [ ] Filter by entity type, date range, admin
- [ ] Export audit log to CSV
```

#### 2.4 Admin Dashboard UI
```
Screens:
- [ ] Dashboard home (stats, recent orders, low stock alerts)
- [ ] Product list (table, search, filter, sort)
- [ ] Product editor (create/edit form, image upload)
- [ ] Category manager (tree view, drag-to-reorder)
- [ ] Collection manager (list, add/remove products)
- [ ] Audit log viewer (filterable table)

Features:
- [ ] Bulk operations (select multiple, bulk edit)
- [ ] Quick edit (inline editing where possible)
- [ ] Undo/redo (for supported operations)
- [ ] Image preview and optimization
- [ ] Form validation with clear errors
- [ ] Keyboard shortcuts (Cmd+S to save, Cmd+K for commands)
- [ ] Dark mode support
```

### Definition of Done
- [ ] Admin can create 10 products successfully
- [ ] Audit log shows all changes
- [ ] All product updates reflected in audit log
- [ ] Dashboard feels fast (LCP < 2s)
- [ ] Mobile dashboard usable (responsive)
- [ ] No console errors or warnings

### Budget: 60 hours

---

## Phase 3: Product Import System (Weeks 6-8)

### Goals
- ✓ Import products from supplier URLs
- ✓ Parse and validate product data
- ✓ Download and optimize images
- ✓ Create variants automatically (if applicable)
- ✓ Bulk import hundreds of products
- ✓ View import progress and logs

### Deliverables

#### 3.1 Import Engine
```
Supported Sources:
- [ ] Generic HTTP URL (HTML parsing)
- [ ] JSON API endpoint
- [ ] CSV upload
- [ ] Future: Shopify API, WooCommerce API

Parsing Pipeline:
- [ ] Fetch page/data
- [ ] Extract title, price, description, images
- [ ] Map to product fields (title, price, category)
- [ ] Create unique SKU
- [ ] Generate slug
- [ ] Create variants (size, color if available)
- [ ] Download images (parallel, with retries)
- [ ] Validate against schema

Error Handling:
- [ ] Network errors (retry 3x with backoff)
- [ ] Parse errors (log and skip)
- [ ] Duplicate SKU (rename and warn)
- [ ] Image not found (use placeholder)
- [ ] Price missing (ask admin before creating)
```

#### 3.2 Bulk Import APIs
```
Endpoints:
- POST   /api/v1/admin/import/start          (begin import)
- GET    /api/v1/admin/import/{batchId}      (check progress)
- GET    /api/v1/admin/import/{batchId}/log  (detailed logs)
- DELETE /api/v1/admin/import/{batchId}      (cancel import)

Import Response:
{
  "batchId": "imp_123",
  "status": "processing",
  "progress": { "completed": 45, "total": 100, "errors": 2 },
  "eta": "2 minutes",
  "logs": [
    { "product": "SKU001", "status": "ok", "id": "prod_123" },
    { "product": "SKU002", "status": "error", "reason": "price_missing" }
  ]
}
```

#### 3.3 Image Processing
```
Flow:
1. Download original image
2. Validate (JPEG/PNG, <50MB)
3. Generate thumbnails (150x200, 300x400, 600x800, 1200x1600)
4. Optimize (compression, progressive JPEG)
5. Upload to Supabase Storage
6. Store URLs in product_images table
7. Serve via CDN

Tests:
- [ ] Large images compressed properly
- [ ] WebP fallback generated
- [ ] Corrupted images handled gracefully
- [ ] Image URLs accessible via CDN
- [ ] Concurrent uploads don't fail
```

#### 3.4 Import Dashboard UI
```
Screens:
- [ ] Import source setup (URL entry, credentials)
- [ ] Import preview (show first 10 products to be imported)
- [ ] Import progress (live progress bar, ETA, log tail)
- [ ] Import results (summary, errors, successful imports)
- [ ] Retry failed (re-import with corrections)

Features:
- [ ] Drag-to-upload CSV
- [ ] Map CSV columns to product fields
- [ ] Preview data before import
- [ ] Cancel import mid-way
- [ ] Pause and resume
- [ ] View detailed logs
```

### Definition of Done
- [ ] Successfully imported 100 products from test source
- [ ] All images downloaded and optimized
- [ ] Import progress visible in real-time
- [ ] Failed imports logged with reasons
- [ ] Admin can retry failed items
- [ ] Import took < 10 minutes for 100 products

### Budget: 80 hours

---

## Phase 4: Order Management & Cart (Weeks 9-11)

### Goals
- ✓ Shopping cart fully functional (add, remove, update quantity)
- ✓ Checkout flow (address, payment method selection)
- ✓ Order creation and tracking
- ✓ Inventory management (stock decrement on order)
- ✓ Admin order management
- ✓ WhatsApp order notifications (future: payment integration)

### Deliverables

#### 4.1 Cart APIs
```
Endpoints:
- GET    /api/v1/cart                (get current cart)
- POST   /api/v1/cart/items          (add to cart)
- PATCH  /api/v1/cart/items/{id}     (update quantity)
- DELETE /api/v1/cart/items/{id}     (remove from cart)
- DELETE /api/v1/cart               (clear cart)
- POST   /api/v1/cart/apply-coupon  (apply discount code)

Cart Structure:
{
  "id": "cart_123",
  "items": [
    {
      "id": "item_1",
      "productId": "prod_456",
      "variantId": "var_789",
      "quantity": 2,
      "price": 150.00,
      "title": "Premium Kurti"
    }
  ],
  "subtotal": 300.00,
  "discount": 0,
  "tax": 30.00,
  "total": 330.00,
  "currency": "USD"
}

Tests:
- [ ] Add to cart updates total
- [ ] Remove from cart updates total
- [ ] Quantity update recalculates price
- [ ] Cannot add more than available stock
- [ ] Cart persists across sessions
- [ ] Out-of-stock items handled on checkout
- [ ] Price shown in customer's currency
```

#### 4.2 Checkout & Order APIs
```
Endpoints:
- POST   /api/v1/orders              (create order from cart)
- GET    /api/v1/orders/{orderId}    (get order details)
- GET    /api/v1/orders              (customer's orders)
- GET    /api/v1/admin/orders        (admin all orders)
- PATCH  /api/v1/admin/orders/{id}/status (update status)

Order Creation:
POST /api/v1/orders
{
  "customerName": "Fatima Ahmed",
  "customerEmail": "fatima@example.com",
  "customerPhone": "+971501234567",
  "shippingAddress": "123 Main St, Dubai",
  "shippingCity": "Dubai",
  "shippingCountry": "AE",
  "notes": "Leave at doorstep"
}

Response:
{
  "id": "ord_999",
  "orderNumber": "ALM-20260514-001",
  "status": "pending_payment",
  "total": 330.00,
  "items": [...],
  "createdAt": "2026-05-14T..."
}

Tests:
- [ ] Order created with valid data
- [ ] Inventory decremented on order
- [ ] Order immutable after creation
- [ ] Order number is unique
- [ ] Order status transitions valid (pending → confirmed → shipped → delivered)
- [ ] Cannot order more than available
- [ ] Concurrent orders don't cause overselling
```

#### 4.3 Inventory Management
```
Stock Calculation:
available_stock = stock_quantity - reserved_quantity

When order created:
- [ ] Check available stock
- [ ] Reserve stock (reserved_quantity++)
- [ ] Create order

When order confirmed (post-payment):
- [ ] Finalize stock (stock_quantity--, reserved_quantity--)

When order cancelled:
- [ ] Release reserved stock (reserved_quantity--)
- [ ] Restore stock_quantity if fully refunded

Tests:
- [ ] Stock reservation prevents overselling
- [ ] Multiple concurrent orders handled correctly
- [ ] Cancellation restores stock
- [ ] Low stock alerts trigger at <10 units
- [ ] Admin can manually adjust stock
```

#### 4.4 Order Management Dashboard
```
Screens:
- [ ] Orders list (filterable, sortable, searchable)
- [ ] Order detail (items, address, timeline, actions)
- [ ] Order status editor (change status, add note)
- [ ] Customer communication (view order messages)

Features:
- [ ] Order search (by number, customer name, email)
- [ ] Filter by status, date, amount
- [ ] Mark as shipped (track updates)
- [ ] Send WhatsApp order confirmation
- [ ] View customer profile
- [ ] Bulk operations (mark as shipped, send notifications)

Reports:
- [ ] Daily orders count
- [ ] Total revenue
- [ ] Top products (by quantity, by revenue)
- [ ] Geographic distribution
- [ ] Customer repeat rate
```

### Definition of Done
- [ ] Can add product to cart
- [ ] Checkout flow creates order successfully
- [ ] Order status changes reflected in dashboard
- [ ] Inventory depleted on order creation
- [ ] Admin can view and manage orders
- [ ] Cart persists across browser refresh

### Budget: 100 hours

---

## Phase 5: Customer Frontend (Weeks 12-14)

### Goals
- ✓ Public product catalog (homepage, product pages, collections)
- ✓ Working shopping experience (browse, add to cart, checkout)
- ✓ Customer accounts and order tracking
- ✓ Luxury minimal design (Zara/Massimo Dutti inspired)
- ✓ Mobile-first responsive design
- ✓ Fast loading (<2.5s LCP), SEO optimized

### Deliverables

#### 5.1 Public Pages & Components
```
Pages:
- [ ] Homepage (hero, featured collections, latest products)
- [ ] Product page (images, details, variants, reviews, related)
- [ ] Collection page (filtered products, sorting)
- [ ] All products (with faceted filters, infinite scroll)
- [ ] Cart page (review items, apply coupon)
- [ ] Checkout page (shipping, billing, payment method)
- [ ] Order confirmation page
- [ ] Customer login/signup page
- [ ] Customer dashboard (orders, wishlist, addresses)

Components (Reusable):
- [ ] ProductCard (image, title, price, quick add)
- [ ] ImageGallery (main + thumbnails, zoom on hover)
- [ ] SizeGuide (expandable, responsive)
- [ ] VariantSelector (size/color with availability)
- [ ] Breadcrumbs (category hierarchy)
- [ ] Filters (category, size, color, price)
- [ ] Pagination (with infinite scroll fallback)
- [ ] Toast notifications
- [ ] Modal dialogs

Animations (Framer Motion):
- [ ] Image fade-in on load
- [ ] Add to cart → cart icon animation
- [ ] Smooth page transitions
- [ ] Drawer slide animations
- [ ] Hover effects (subtle, premium feel)
```

#### 5.2 Homepage & Navigation
```
Homepage:
- [ ] Hero section (full-width image, CTA)
- [ ] Featured collections (3-4 collections, carousel)
- [ ] Latest products (grid, 6-8 items)
- [ ] Newsletter signup
- [ ] Customer testimonials
- [ ] Footer (links, contact, newsletter)

Navigation:
- [ ] Desktop header (logo, search, menu, cart, account)
- [ ] Mobile header (logo, menu button, search, cart)
- [ ] Mobile menu (full-screen, smooth animations)
- [ ] Search functionality (real-time results)
- [ ] Breadcrumbs (context awareness)

Design:
- [ ] Black, white, beige color palette
- [ ] Elegant typography (primary + secondary fonts)
- [ ] Generous white space
- [ ] Cinematic spacing (visual hierarchy)
- [ ] Minimal icons (not cluttered)
```

#### 5.3 Product Pages
```
Product Page Layout:
- [ ] Left: Image gallery (thumbnail strip)
- [ ] Right: Title, price, ratings, description
- [ ] Variant selector (size, color swatches)
- [ ] Quantity selector
- [ ] Add to cart / Buy now buttons
- [ ] Wishlist / Share buttons
- [ ] Product details (fabric, care, dimensions)
- [ ] Related products (same category)

Features:
- [ ] Image zoom on hover (desktop)
- [ ] Image swipe on mobile
- [ ] Variant selection updates images
- [ ] Stock status displayed
- [ ] Available shipping methods
- [ ] Estimated delivery date

SEO:
- [ ] Dynamic meta titles (product name + brand)
- [ ] Meta descriptions (first 160 chars of description)
- [ ] Open Graph tags (social sharing)
- [ ] Structured data (schema.org Product)
- [ ] Canonical URLs
```

#### 5.4 Checkout Flow
```
Steps:
1. Cart Review (edit items, apply coupon)
2. Shipping Address (new/saved address)
3. Billing Address (same/different)
4. Payment Method Selection (COD, future: card/Stripe)
5. Order Review (confirm order details)
6. Confirmation (order number, WhatsApp opt-in)

Features:
- [ ] Address autocomplete (Google Maps)
- [ ] Save address for future orders
- [ ] Estimated shipping cost
- [ ] Estimated delivery date
- [ ] Payment method icons
- [ ] Order total recap
- [ ] Mobile number required
- [ ] Newsletter opt-in
- [ ] Error handling and retries

Tests:
- [ ] Checkout flow end-to-end
- [ ] Cannot checkout without phone
- [ ] Address validation
- [ ] Order created on submission
- [ ] Confirmation email sent
- [ ] WhatsApp message sent
```

#### 5.5 Performance & SEO Optimization
```
Performance:
- [ ] Code splitting (route-based)
- [ ] Image optimization (next/image)
- [ ] Lazy loading (below-the-fold content)
- [ ] Caching strategy (static products, dynamic carts)
- [ ] Database query optimization
- [ ] Compression (gzip, Brotli)
- [ ] CDN for assets

Metrics:
- [ ] FCP < 1.5s
- [ ] LCP < 2.5s
- [ ] TTI < 3s
- [ ] CLS < 0.1
- [ ] Core Web Vitals: All green
- [ ] Lighthouse score: > 90

SEO:
- [ ] XML sitemap (products, collections)
- [ ] robots.txt configured
- [ ] Structured data for products
- [ ] Canonical URLs
- [ ] Mobile-friendly (responsive)
- [ ] Alt text on all images
- [ ] Internal linking strategy
```

### Definition of Done
- [ ] Homepage loads in <2s
- [ ] Can browse products by category
- [ ] Can add product to cart
- [ ] Checkout flow works end-to-end
- [ ] Mobile experience is smooth
- [ ] All images load and are optimized
- [ ] No console errors or warnings
- [ ] Lighthouse score > 90

### Budget: 120 hours

---

## Phase 6: Launch & Optimization (Weeks 15-16)

### Goals
- ✓ Final QA and bug fixes
- ✓ Performance optimization
- ✓ Security audit
- ✓ Setup monitoring and alerting
- ✓ Launch to production
- ✓ Document runbooks

### Deliverables

#### 6.1 Testing & QA
```
Manual Testing:
- [ ] 50+ test cases executed
- [ ] All user flows tested
- [ ] Mobile testing (iOS/Android)
- [ ] Browser testing (Chrome, Safari, Firefox)
- [ ] Edge cases (empty carts, out of stock, network failures)
- [ ] Payment flow testing (sandbox)

Automated Testing:
- [ ] Unit tests coverage > 80%
- [ ] Integration tests for APIs
- [ ] E2E tests for critical flows
- [ ] Performance tests (load testing)
- [ ] Visual regression tests

Security:
- [ ] Penetration testing
- [ ] SQL injection prevention verified
- [ ] XSS prevention verified
- [ ] CSRF token validation verified
- [ ] Input validation comprehensive
- [ ] Rate limiting effective
```

#### 6.2 Performance Optimization
```
Final Optimizations:
- [ ] Minify and bundle code
- [ ] Implement service worker (PWA ready)
- [ ] Edge function optimization
- [ ] Database query optimization
- [ ] Remove unused dependencies
- [ ] Optimize font loading
- [ ] Final image optimization

Monitoring:
- [ ] Sentry for error tracking
- [ ] Vercel Analytics for performance
- [ ] Custom logging for business metrics
- [ ] Uptime monitoring
- [ ] Alert thresholds set
```

#### 6.3 Production Preparation
```
Tasks:
- [ ] Production database backup strategy confirmed
- [ ] SSL certificate installed
- [ ] Domain DNS configured
- [ ] Email provider setup (SendGrid/similar)
- [ ] WhatsApp Business account active
- [ ] Analytics setup (Google Analytics)
- [ ] Monitoring alerts configured
- [ ] Runbooks documented
- [ ] Incident response plan
- [ ] On-call rotation established

Deployment:
- [ ] Create production branch
- [ ] Final staging tests
- [ ] Zero-downtime deployment plan
- [ ] Rollback plan documented
- [ ] Health checks automated
```

#### 6.4 Launch & Post-Launch
```
Pre-Launch Checklist:
- [ ] All tests passing
- [ ] No performance regressions
- [ ] Error tracking working
- [ ] Monitoring alerts tested
- [ ] Team trained on operations
- [ ] Runbooks reviewed

Launch Day:
- [ ] Deploy to production
- [ ] Smoke test production
- [ ] Monitor errors and performance
- [ ] Team on standby

Post-Launch (Week 1):
- [ ] Fix any critical bugs within 24h
- [ ] Gather user feedback
- [ ] Monitor key metrics
- [ ] Optimize based on usage patterns
- [ ] Document learnings

Post-Launch (Week 2):
- [ ] Plan Phase 7 (payments, ratings, etc.)
- [ ] Retrospective on launch
- [ ] Optimize based on metrics
```

### Definition of Done
- [ ] All tests passing
- [ ] Lighthouse score > 90
- [ ] Performance monitoring working
- [ ] Error tracking active
- [ ] Site live and accessible
- [ ] Team confident in operations
- [ ] First 24h with < 1% error rate

### Budget: 60 hours

---

## Total Development Budget: ~480 hours (~12 weeks at 40h/week)

---

## Quality Gates Between Phases

```
Before moving to next phase:
□ All acceptance criteria met for current phase
□ Zero critical bugs outstanding
□ Code review completed
□ Tests passing (>80% coverage)
□ Performance budget met
□ No technical debt accumulated
□ Documentation updated
□ Team sign-off obtained
```

---

## Risk Mitigation

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Third-party API downtime | Payment failures | Use multiple payment processors, fallback to COD |
| Database corruption | Data loss | Daily backups, point-in-time recovery |
| Image processing bottleneck | Import delays | Async job queue, auto-scaling |
| Performance regression | Poor UX | Performance budget in CI/CD, monitoring |
| Security breach | Customer data leak | Penetration testing, rate limiting, encryption |

---

*Development roadmap maintained in: `/DEVELOPMENT_PHASES.md`*  
*Version 1.0 | Last Updated: May 2026*
