# Alma Lifestyle Ecommerce

**Status**: Foundation Complete ✓ | **Next Phase**: Phase 1 Implementation

See **FOUNDATION.md** for complete overview and next steps.

---

## Overview

Alma Lifestyle is a luxury fashion ecommerce brand focused on Punjabi/Panjabi fashion for UAE and Bangladesh audiences.

The website should feel premium, minimal, modern, and mobile-first.

**Build approach**: Admin-first, API-first, database-first (not UI-first).

---

## Foundation Documents

Complete architecture & planning is documented in:

| Document | Purpose |
|----------|---------|
| **FOUNDATION.md** | Start here - overview & next steps |
| **ARCHITECTURE.md** | Complete system design & principles |
| **DATABASE_SCHEMA.md** | Data model (14 tables, relationships) |
| **DEVELOPMENT_PHASES.md** | 16-week roadmap (6 phases) |
| **CODING_STANDARDS.md** | Code quality & patterns |
| **ADMIN_WORKFLOW.md** | Admin operations & APIs |
| **FOLDER_STRUCTURE.md** | Project organization |

---

## Business Model

**Phase 1-3 (Months 1-3): MVP with Imports**
- Import products from supplier URLs
- Full independence after import (edit everything)
- Products saved to our own database
- Bulk import support (CSV, API, JSON)

**Phase 4+ (Months 4+): Growth & Features**
- Original in-house products
- Advanced search & recommendations
- Customer reviews & ratings
- Loyalty program
- Multi-vendor support
- Expand into full luxury fashion brand

---

## Core Features

### Admin System (Build First - Phase 2)
- Complete product management (CRUD)
- Bulk product importer (Phase 3)
- Category & collection management
- Order management & tracking
- Inventory management
- Analytics dashboard
- Audit logging (compliance)
- Team & permissions

### Customer Frontend (Build Later - Phase 5)
- Homepage & featured collections
- Product catalog with search & filters
- Product detail pages with images
- Shopping cart & checkout
- Customer account & order history
- WhatsApp order notifications
- Mobile-optimized experience

---

## Tech Stack

### Frontend
- Next.js 14 (App Router, Server Components)
- TypeScript (strict mode)
- Tailwind CSS (utility-first)
- Framer Motion (animations)

### Backend
- Next.js API Routes
- Supabase PostgreSQL (database)
- Supabase Storage (images)
- Zod (validation)

### Infrastructure
- Vercel (hosting, edge functions, analytics)
- Supabase (managed database)
- GitHub Actions (CI/CD)

---

## Design Style

**Luxury Minimal Aesthetic**

Inspired by: Zara, Massimo Dutti, Brunello Cucinelli

- **Colors**: Black, White, Beige, Cream
- **Typography**: Elegant serif + modern sans-serif
- **Spacing**: Generous white space, cinematic layout
- **Imagery**: High-quality product photos, lifestyle
- **Movement**: Smooth animations, subtle transitions
- **Feel**: Premium, not busy, not sparse

---

## Core Principles

### 1. Admin-First Development ⭐
Build complete admin system & APIs first, then customer UI.
- Admin tests all endpoints
- APIs proven before customer use
- Consistent patterns across system
- Easier to maintain & scale

### 2. Import-Driven Data
Products initially from supplier URLs, then independently managed.
- Bulk import from multiple sources
- Full editing after import
- Track import source for audits
- Variants auto-created if available

### 3. Multi-Brand Ready
Even with single brand now, architecture supports future expansion.
- All tables include brand_id
- APIs support brand filtering
- Pricing in 3 currencies (USD, AED, BDT)
- Image paths namespaced

### 4. Audit & Compliance
All admin operations tracked, all changes reversible.
- Complete audit trail
- Soft deletes (no permanent loss)
- Immutable orders
- Admin action logging

### 5. Performance First
Fast loading, optimized images, caching strategy.
- Target: LCP < 2.5s, Lighthouse > 90
- Image optimization (multiple sizes, CDN)
- Caching (products, collections, carts)
- Code splitting & lazy loading

---

## Important Rules

✓ **Admin system first** - Build complete APIs & admin UI before customer pages  
✓ **Mobile-first** - Design for mobile, enhance for desktop  
✓ **Clean architecture** - Separate concerns, reusable components  
✓ **Type-safe** - Strict TypeScript, no "any"  
✓ **SEO optimized** - Meta tags, structured data, sitemaps  
✓ **Fast loading** - Target <2.5s LCP, optimize images  
✓ **Admin workflow** - Make admin operations easy & efficient  

---

## Next Steps

1. **Read FOUNDATION.md** (overview & summary)
2. **Read ARCHITECTURE.md** (system design)
3. **Prepare environment** (Supabase, GitHub, Vercel)
4. **Begin Phase 1** (Database + Authentication)

**Timeline**: 16 weeks to public launch (5 more weeks of development + launch)

---

*Last Updated: May 14, 2026*  
*All documentation in repo root*