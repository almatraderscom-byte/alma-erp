# Alma Lifestyle Ecommerce Architecture

**Status**: Foundation Design | **Version**: 1.0  
**Project**: Luxury Punjabi Fashion Ecommerce | **Target**: UAE & Bangladesh

---

## Executive Summary

Alma Lifestyle is a luxury fashion ecommerce platform featuring Punjabi/Panjabi collections. The architecture prioritizes:
- **Admin-first development** (backend/APIs before UI)
- **Scalability** (handle future growth to multi-brand)
- **Separation of concerns** (ERP ≠ Ecommerce)
- **Premium UX** (minimal, fast, mobile-first)
- **Import-driven initially** (supplier URLs → our DB)

---

## System Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    Alma Ecommerce Stack                  │
└─────────────────────────────────────────────────────────┘

FRONTEND (Vercel)
├── Public Site (Next.js)
│   ├── Homepage
│   ├── Product Pages
│   ├── Collections
│   ├── Cart & Checkout
│   └── Customer Portal
└── Admin Dashboard (Next.js)
    ├── Product Management
    ├── Importer Tool
    ├── Collections
    ├── Orders
    └── Analytics

↓ API Layer (Next.js API Routes)

BACKEND SERVICES
├── Product Service (CRUD, Images, Collections)
├── Order Service (Creation, Tracking, Status)
├── Cart Service (Session, Persistence)
├── Inventory Service (Stock Levels)
├── Import Service (Supplier URLs → DB)
├── Image Service (Upload, Resize, CDN)
└── Authentication Service (Admin, Customers)

↓ Data Layer

DATABASE (Supabase PostgreSQL)
├── Products Table
├── Variants Table
├── Collections Table
├── Orders Table
├── Order Items Table
├── Cart Sessions Table
├── Customer Accounts Table
├── Inventory Table
├── Images Table
└── Import Logs Table

EXTERNAL SERVICES
├── Image Storage (Supabase Storage)
├── WhatsApp Business API
└── Stripe/PayU (Future Payments)
```

---

## Core Principles

### 1. **Admin-First Development**
- Build complete APIs and backend first
- Admin dashboard uses same APIs as frontend
- APIs fully testable without UI
- Clear separation: admin operations ≠ customer experience

### 2. **Scalability for Multi-Brand Future**
- Database includes `brand_id` on all relevant tables
- APIs support brand filtering
- Admin system supports multi-brand management
- Image paths include brand namespace

### 3. **Luxury UX Standards**
- Mobile-first but premium on desktop
- Minimal design (black, white, beige)
- Fast load times (<2s LCP)
- Smooth animations (Framer Motion)
- Zero friction checkout

### 4. **Import-Driven Data Model**
- Products initially imported from supplier URLs
- Full independence after import (edit everything)
- Track import source for future sync options
- Support bulk operations for efficiency

### 5. **Clean Separation of Concerns**
```
Alma ERP (Separate System)
├── Accounting
├── Invoicing
├── CRM
└── Legacy Order System

Alma Ecommerce (This Project)
├── Product Catalog
├── Shopping Experience
├── Order Processing
└── Customer Portal
```

---

## API-First Design

### Authentication Layer
```
Endpoints require:
- Customer Auth: JWT tokens (sessions)
- Admin Auth: OAuth + session + 2FA ready
- API Keys: Service-to-service calls
- Rate limiting: 1000 req/min (customer), 10000 req/min (admin)
```

### API Versioning Strategy
```
/api/v1/products
/api/v1/orders
/api/v1/cart
/api/v1/admin/products
/api/v1/admin/orders
/api/v1/admin/import
```

### Error Handling Standards
```typescript
Success Response: { status: "success", data: {...} }
Error Response: { status: "error", code: "ERR_CODE", message: "...", details: {...} }
Validation Error: { status: "error", code: "VALIDATION_ERROR", errors: [{field, message}] }
```

---

## Data Model Philosophy

### Single Source of Truth
- Products: DB is truth (not suppliers)
- Orders: DB is truth (not WhatsApp logs)
- Inventory: DB is truth (calculated from orders + adjustments)

### Audit Trail
- All modifications timestamped
- Track who/when/what changed
- Soft deletes where appropriate
- Enable rollback for critical data

### Referential Integrity
- Foreign keys enforced
- No orphaned records
- Cascade rules clearly defined
- Backup strategy in place

---

## Integration Architecture

### Import Flow
```
Supplier URL
    ↓
Fetch & Parse
    ↓
Validate (SKU, Title, Price, Images)
    ↓
Create Product Record
    ↓
Download & Process Images
    ↓
Create Variants
    ↓
Assign to Collection
    ↓
Status: Published
```

### Order Processing Flow
```
Customer Creates Order
    ↓
Stock Check
    ↓
Create Order Record (status: pending_payment)
    ↓
[Future: Payment processing]
    ↓
Create Invoice
    ↓
Update Inventory
    ↓
Send WhatsApp confirmation
    ↓
Status: confirmed
```

---

## Performance & Scaling

### Caching Strategy
```
Cache Layer:
├── Vercel Edge (static products, collections)
├── Browser (auth tokens, cart)
├── Database (materialized views for analytics)
└── API response caching (collections, categories)

Cache Invalidation:
├── Product update → invalidate in 5 minutes
├── Inventory change → invalidate immediately
├── Collection change → invalidate in 1 minute
```

### Database Optimization
```
Indexes:
├── products(brand_id, slug, published_at)
├── products(category_id, published_at)
├── orders(customer_id, created_at)
├── order_items(order_id)
└── variants(product_id)

Partitioning:
├── Orders by month (future, when >1M records)
└── Analytics tables by brand
```

### Image Optimization
```
Store Original → Generate Variants
├── Thumbnail (150x200)
├── Product List (300x400)
├── Product Page (600x800, 1200x1600)
└── Hero/Banner (1920x1080, 1080x1350 mobile)

CDN: Supabase Storage + Vercel Edge Cache
```

---

## Security Architecture

### Authentication & Authorization
```
Customer:
├── JWT tokens (short-lived: 1h)
├── Refresh tokens (long-lived: 30d)
└── Email verification required

Admin:
├── OAuth integration (future)
├── 2FA support (TOTP)
├── Session tokens (secure HttpOnly cookies)
└── IP whitelisting (optional)

API Keys:
├── Service-to-service (hashed, rotatable)
├── Rate-limited per key
└── Scope-limited permissions
```

### Data Protection
```
- SSL/TLS for all traffic
- PII encryption at rest (passwords, emails)
- Input validation on all endpoints
- CSRF tokens for state-changing requests
- SQL injection prevention (parameterized queries)
- XSS prevention (sanitized output)
```

### Admin-Only Operations
```
/api/v1/admin/* routes:
├── Require admin authentication
├── Audit logged
├── Change tracked
└── Reversible (soft delete, restore)
```

---

## Deployment Architecture

### Development Environment
```
Local Development:
├── Next.js dev server (localhost:3000)
├── Supabase local (docker-compose)
├── Environment variables (.env.local)
└── Mock data seeding
```

### Staging Environment
```
Staging (staging.almalifestyle.com):
├── Deployed on Vercel
├── Connected to staging Supabase
├── Full data mirroring (sanitized)
├── All features enabled
└── Performance monitoring enabled
```

### Production Environment
```
Production (almalifestyle.com):
├── Deployed on Vercel (with rollback ready)
├── Production Supabase
├── Automated backups (daily)
├── CDN enabled
├── Monitoring & alerting
└── Zero-downtime deployments
```

---

## Technology Rationale

| Component | Choice | Why |
|-----------|--------|-----|
| Frontend Framework | Next.js 14 | SSR, SSG, API routes, edge functions |
| Database | Supabase (PostgreSQL) | Managed, real-time capable, scalable |
| Hosting | Vercel | Next.js native, edge functions, analytics |
| UI Framework | Tailwind + Framer Motion | Minimal design, performance, animations |
| Image Hosting | Supabase Storage | Integrated, CDN-capable, cost-effective |
| Auth | JWT + Session | Stateless, scalable, mobile-friendly |
| Real-time | Supabase subscriptions (future) | Admin notifications, live inventory |

---

## Success Metrics

### Performance
- [ ] First Contentful Paint (FCP) < 1.5s
- [ ] Largest Contentful Paint (LCP) < 2.5s
- [ ] Time to Interactive (TTI) < 3s
- [ ] Lighthouse score > 90

### Reliability
- [ ] API uptime > 99.9%
- [ ] Zero data loss incidents
- [ ] Recovery time < 15 minutes
- [ ] All operations reversible

### User Experience
- [ ] Cart abandonment < 70% (industry avg 70-80%)
- [ ] Checkout completion > 3% of visitors
- [ ] Mobile conversion > 40% of desktop
- [ ] Customer satisfaction > 4.5/5

### Operational
- [ ] Deployment time < 5 minutes
- [ ] Zero-downtime deployments
- [ ] Admin operations logged 100%
- [ ] Data changes reversible 100%

---

## Next Steps

1. **Finalize Database Schema** → DATABASE_SCHEMA.md
2. **Define Development Phases** → DEVELOPMENT_PHASES.md
3. **Set Coding Standards** → CODING_STANDARDS.md
4. **Establish Admin Workflow** → ADMIN_WORKFLOW.md
5. **Create Folder Structure** → FOLDER_STRUCTURE.md

---

*Document maintained as: `/ARCHITECTURE.md`*  
*Last Updated: May 2026*
