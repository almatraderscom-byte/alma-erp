# Folder Structure - Alma Lifestyle Ecommerce

**Version**: 1.0 | **Framework**: Next.js 14 App Router  
**Philosophy**: Scalable, organized, easy to navigate

---

## Complete Folder Architecture

```
alma-erp/
│
├── 📋 Root Configuration Files
│   ├── package.json                 # Dependencies, scripts
│   ├── tsconfig.json               # TypeScript configuration
│   ├── next.config.js              # Next.js configuration
│   ├── tailwind.config.ts           # Tailwind CSS configuration
│   ├── postcss.config.js           # PostCSS configuration
│   ├── .env.local                  # Local environment variables
│   ├── .env.example                # Environment variable template
│   ├── .gitignore                  # Git ignore rules
│   ├── .eslintrc.json              # ESLint configuration
│   ├── .prettierrc                 # Prettier configuration
│   │
│   └── 📚 Documentation Files
│       ├── README.md               # Project overview
│       ├── ARCHITECTURE.md         # Architecture documentation
│       ├── DATABASE_SCHEMA.md      # Database design
│       ├── DEVELOPMENT_PHASES.md   # Development roadmap
│       ├── CODING_STANDARDS.md     # Coding guidelines
│       ├── ADMIN_WORKFLOW.md       # Admin system workflow
│       ├── FOLDER_STRUCTURE.md     # This file
│       └── PROJECT_ROADMAP.md      # Business roadmap
│
├── 📁 src/
│   │
│   ├── 🎯 app/                     # Next.js App Router (Server Components by default)
│   │   │
│   │   ├── (admin)/                # Admin section (layout grouping)
│   │   │   ├── layout.tsx          # Admin layout (sidebar, auth check)
│   │   │   ├── page.tsx            # Admin dashboard /admin
│   │   │   │
│   │   │   ├── dashboard/          # Dashboard pages
│   │   │   │   ├── page.tsx        # /admin/dashboard
│   │   │   │   └── charts/
│   │   │   │       └── page.tsx    # /admin/dashboard/charts
│   │   │   │
│   │   │   ├── products/           # Product management
│   │   │   │   ├── page.tsx        # /admin/products (list)
│   │   │   │   ├── new/
│   │   │   │   │   └── page.tsx    # /admin/products/new
│   │   │   │   ├── [id]/
│   │   │   │   │   ├── page.tsx    # /admin/products/[id] (edit)
│   │   │   │   │   ├── images/
│   │   │   │   │   │   └── page.tsx
│   │   │   │   │   └── variants/
│   │   │   │   │       └── page.tsx
│   │   │   │   └── import/
│   │   │   │       ├── page.tsx    # /admin/products/import
│   │   │   │       └── preview/
│   │   │   │           └── page.tsx
│   │   │   │
│   │   │   ├── collections/        # Collection management
│   │   │   │   ├── page.tsx        # /admin/collections
│   │   │   │   ├── new/
│   │   │   │   │   └── page.tsx
│   │   │   │   └── [id]/
│   │   │   │       └── page.tsx
│   │   │   │
│   │   │   ├── categories/         # Category management
│   │   │   │   ├── page.tsx        # /admin/categories
│   │   │   │   └── [id]/
│   │   │   │       └── page.tsx
│   │   │   │
│   │   │   ├── orders/             # Order management
│   │   │   │   ├── page.tsx        # /admin/orders
│   │   │   │   └── [id]/
│   │   │   │       ├── page.tsx    # /admin/orders/[id]
│   │   │   │       └── invoice/
│   │   │   │           └── page.tsx
│   │   │   │
│   │   │   ├── customers/          # Customer management
│   │   │   │   ├── page.tsx        # /admin/customers
│   │   │   │   └── [id]/
│   │   │   │       └── page.tsx
│   │   │   │
│   │   │   ├── analytics/          # Analytics & reports
│   │   │   │   ├── page.tsx        # /admin/analytics
│   │   │   │   ├── sales/
│   │   │   │   │   └── page.tsx
│   │   │   │   ├── products/
│   │   │   │   │   └── page.tsx
│   │   │   │   └── customers/
│   │   │   │       └── page.tsx
│   │   │   │
│   │   │   └── settings/           # Admin settings
│   │   │       ├── page.tsx        # /admin/settings
│   │   │       ├── brand/
│   │   │       │   └── page.tsx
│   │   │       ├── team/
│   │   │       │   └── page.tsx
│   │   │       └── audit-log/
│   │   │           └── page.tsx
│   │   │
│   │   ├── (shop)/                 # Customer section (layout grouping)
│   │   │   ├── layout.tsx          # Shop layout (header, footer)
│   │   │   ├── page.tsx            # Homepage /
│   │   │   │
│   │   │   ├── products/           # Product browsing
│   │   │   │   ├── page.tsx        # /products (all products)
│   │   │   │   └── [slug]/
│   │   │   │       └── page.tsx    # /products/[slug] (single product)
│   │   │   │
│   │   │   ├── collections/        # Collection pages
│   │   │   │   ├── page.tsx        # /collections (all collections)
│   │   │   │   └── [slug]/
│   │   │   │       └── page.tsx    # /collections/[slug]
│   │   │   │
│   │   │   ├── search/             # Search results
│   │   │   │   └── page.tsx        # /search?q=query
│   │   │   │
│   │   │   ├── cart/               # Shopping cart
│   │   │   │   └── page.tsx        # /cart
│   │   │   │
│   │   │   ├── checkout/           # Checkout flow
│   │   │   │   ├── page.tsx        # /checkout
│   │   │   │   ├── shipping/
│   │   │   │   │   └── page.tsx
│   │   │   │   ├── billing/
│   │   │   │   │   └── page.tsx
│   │   │   │   ├── payment/
│   │   │   │   │   └── page.tsx
│   │   │   │   └── confirmation/
│   │   │   │       └── page.tsx
│   │   │   │
│   │   │   ├── account/            # Customer account
│   │   │   │   ├── page.tsx        # /account (profile)
│   │   │   │   ├── orders/
│   │   │   │   │   ├── page.tsx    # /account/orders
│   │   │   │   │   └── [orderId]/
│   │   │   │   │       └── page.tsx
│   │   │   │   ├── addresses/
│   │   │   │   │   └── page.tsx
│   │   │   │   ├── wishlist/
│   │   │   │   │   └── page.tsx
│   │   │   │   └── settings/
│   │   │   │       └── page.tsx
│   │   │   │
│   │   │   ├── about/              # Static pages
│   │   │   │   └── page.tsx        # /about
│   │   │   │
│   │   │   ├── contact/
│   │   │   │   └── page.tsx        # /contact
│   │   │   │
│   │   │   ├── faq/
│   │   │   │   └── page.tsx        # /faq
│   │   │   │
│   │   │   └── returns/
│   │   │       └── page.tsx        # /returns
│   │   │
│   │   ├── 🔐 auth/                # Authentication pages
│   │   │   ├── login/
│   │   │   │   └── page.tsx        # /auth/login
│   │   │   ├── signup/
│   │   │   │   └── page.tsx        # /auth/signup
│   │   │   ├── forgot-password/
│   │   │   │   └── page.tsx
│   │   │   ├── reset-password/
│   │   │   │   └── page.tsx
│   │   │   └── verify-email/
│   │   │       └── page.tsx
│   │   │
│   │   ├── 🔗 api/                 # Next.js API Routes
│   │   │   ├── health/
│   │   │   │   └── route.ts        # GET /api/health
│   │   │   │
│   │   │   ├── v1/                 # API version 1
│   │   │   │   │
│   │   │   │   ├── auth/
│   │   │   │   │   ├── route.ts    # POST /api/v1/auth (signup/login)
│   │   │   │   │   ├── login/
│   │   │   │   │   │   └── route.ts
│   │   │   │   │   ├── signup/
│   │   │   │   │   │   └── route.ts
│   │   │   │   │   ├── logout/
│   │   │   │   │   │   └── route.ts
│   │   │   │   │   ├── refresh/
│   │   │   │   │   │   └── route.ts
│   │   │   │   │   └── verify-email/
│   │   │   │   │       └── route.ts
│   │   │   │   │
│   │   │   │   ├── products/       # Product endpoints
│   │   │   │   │   ├── route.ts    # GET /api/v1/products (public)
│   │   │   │   │   ├── search/
│   │   │   │   │   │   └── route.ts
│   │   │   │   │   └── [id]/
│   │   │   │   │       └── route.ts
│   │   │   │   │
│   │   │   │   ├── collections/
│   │   │   │   │   ├── route.ts    # GET /api/v1/collections (public)
│   │   │   │   │   └── [id]/
│   │   │   │   │       └── route.ts
│   │   │   │   │
│   │   │   │   ├── categories/
│   │   │   │   │   └── route.ts
│   │   │   │   │
│   │   │   │   ├── cart/
│   │   │   │   │   ├── route.ts    # GET /api/v1/cart (get cart)
│   │   │   │   │   ├── items/
│   │   │   │   │   │   └── route.ts # POST add item, PATCH update, DELETE remove
│   │   │   │   │   └── apply-coupon/
│   │   │   │   │       └── route.ts
│   │   │   │   │
│   │   │   │   ├── orders/
│   │   │   │   │   ├── route.ts    # POST /api/v1/orders (create)
│   │   │   │   │   │               # GET /api/v1/orders (list customer orders)
│   │   │   │   │   ├── [id]/
│   │   │   │   │   │   ├── route.ts # GET order details
│   │   │   │   │   │   ├── status/
│   │   │   │   │   │   │   └── route.ts
│   │   │   │   │   │   └── tracking/
│   │   │   │   │   │       └── route.ts
│   │   │   │   │   └── invoice/
│   │   │   │   │       └── route.ts
│   │   │   │   │
│   │   │   │   ├── admin/          # Admin-only endpoints
│   │   │   │   │   ├── auth/
│   │   │   │   │   │   └── route.ts # Admin login
│   │   │   │   │   │
│   │   │   │   │   ├── products/
│   │   │   │   │   │   ├── route.ts # POST create, GET list (admin)
│   │   │   │   │   │   ├── [id]/
│   │   │   │   │   │   │   ├── route.ts # PATCH update, DELETE delete
│   │   │   │   │   │   │   ├── publish/
│   │   │   │   │   │   │   │   └── route.ts
│   │   │   │   │   │   │   ├── variants/
│   │   │   │   │   │   │   │   └── route.ts
│   │   │   │   │   │   │   └── images/
│   │   │   │   │   │   │       └── route.ts
│   │   │   │   │   │   │
│   │   │   │   │   │   └── import/
│   │   │   │   │   │       ├── route.ts # POST start import
│   │   │   │   │   │       ├── [batchId]/
│   │   │   │   │   │       │   └── route.ts # GET progress
│   │   │   │   │   │       └── logs/
│   │   │   │   │   │           └── [batchId]/
│   │   │   │   │   │               └── route.ts
│   │   │   │   │   │
│   │   │   │   │   ├── collections/
│   │   │   │   │   │   ├── route.ts
│   │   │   │   │   │   └── [id]/
│   │   │   │   │   │       └── route.ts
│   │   │   │   │   │
│   │   │   │   │   ├── categories/
│   │   │   │   │   │   ├── route.ts
│   │   │   │   │   │   └── [id]/
│   │   │   │   │   │       └── route.ts
│   │   │   │   │   │
│   │   │   │   │   ├── orders/
│   │   │   │   │   │   ├── route.ts # GET all orders (admin)
│   │   │   │   │   │   └── [id]/
│   │   │   │   │   │       ├── route.ts # GET/PATCH order
│   │   │   │   │   │       └── status/
│   │   │   │   │   │           └── route.ts # PATCH status
│   │   │   │   │   │
│   │   │   │   │   ├── customers/
│   │   │   │   │   │   ├── route.ts
│   │   │   │   │   │   └── [id]/
│   │   │   │   │   │       └── route.ts
│   │   │   │   │   │
│   │   │   │   │   ├── analytics/
│   │   │   │   │   │   ├── route.ts # Dashboard stats
│   │   │   │   │   │   ├── sales/
│   │   │   │   │   │   │   └── route.ts
│   │   │   │   │   │   └── products/
│   │   │   │   │   │       └── route.ts
│   │   │   │   │   │
│   │   │   │   │   ├── audit-logs/
│   │   │   │   │   │   └── route.ts
│   │   │   │   │   │
│   │   │   │   │   ├── inventory/
│   │   │   │   │   │   └── route.ts # Stock management
│   │   │   │   │   │
│   │   │   │   │   └── upload/
│   │   │   │   │       └── route.ts # Image upload
│   │   │   │   │
│   │   │   │   └── webhooks/       # External webhooks
│   │   │   │       ├── stripe/
│   │   │   │       │   └── route.ts
│   │   │   │       └── whatsapp/
│   │   │   │           └── route.ts
│   │   │   │
│   │   │   └── middleware.ts       # Global API middleware (auth, logging)
│   │   │
│   │   └── layout.tsx              # Root layout
│   │
│   ├── 🧩 components/              # Reusable React components
│   │   │
│   │   ├── admin/                  # Admin-only components
│   │   │   ├── ProductForm.tsx     # Create/edit product form
│   │   │   ├── ProductList.tsx     # Paginated product list
│   │   │   ├── ImportProgress.tsx  # Import progress indicator
│   │   │   ├── OrderList.tsx       # Admin order table
│   │   │   ├── OrderDetail.tsx     # Full order details
│   │   │   ├── CollectionManager.tsx
│   │   │   ├── CategoryTree.tsx    # Hierarchical category editor
│   │   │   ├── InventoryAdjust.tsx
│   │   │   ├── AnalyticsDashboard.tsx
│   │   │   ├── AuditLog.tsx        # Audit log viewer
│   │   │   └── AdminSidebar.tsx    # Admin navigation sidebar
│   │   │
│   │   ├── shop/                   # Customer-facing components
│   │   │   ├── ProductCard.tsx     # Reusable product card
│   │   │   ├── ProductGrid.tsx     # Grid of products
│   │   │   ├── ImageGallery.tsx    # Product image carousel
│   │   │   ├── VariantSelector.tsx # Size/color selection
│   │   │   ├── SizeGuide.tsx       # Expandable size guide
│   │   │   ├── ReviewList.tsx      # Product reviews (future)
│   │   │   ├── RelatedProducts.tsx # "You may also like"
│   │   │   ├── CartSummary.tsx     # Cart preview
│   │   │   ├── CheckoutForm.tsx    # Multi-step checkout
│   │   │   ├── AddressForm.tsx     # Address entry/selection
│   │   │   ├── PaymentMethod.tsx   # Payment selection
│   │   │   ├── OrderConfirm.tsx    # Order confirmation details
│   │   │   ├── OrderTracking.tsx   # Shipment tracking
│   │   │   ├── CustomerAccount.tsx # Profile & settings
│   │   │   ├── OrderHistory.tsx    # Past orders list
│   │   │   ├── Filters.tsx         # Product filtering
│   │   │   └── Search.tsx          # Search component
│   │   │
│   │   ├── shared/                 # Used in both admin & shop
│   │   │   ├── Header.tsx          # App header/navigation
│   │   │   ├── Footer.tsx          # App footer
│   │   │   ├── Sidebar.tsx         # Generic sidebar
│   │   │   ├── Breadcrumbs.tsx     # Navigation breadcrumbs
│   │   │   ├── Toast.tsx           # Toast notifications
│   │   │   ├── Modal.tsx           # Modal dialog
│   │   │   ├── Button.tsx          # Base button component
│   │   │   ├── Input.tsx           # Base input component
│   │   │   ├── Select.tsx          # Select dropdown
│   │   │   ├── Badge.tsx           # Status badges
│   │   │   ├── Loading.tsx         # Loading spinner
│   │   │   ├── ErrorBoundary.tsx   # Error boundary wrapper
│   │   │   ├── ConfirmDialog.tsx   # Confirmation modal
│   │   │   └── Pagination.tsx      # Pagination component
│   │   │
│   │   └── __tests__/              # Component tests
│   │       ├── ProductCard.test.tsx
│   │       ├── ImageGallery.test.tsx
│   │       └── CheckoutForm.test.tsx
│   │
│   ├── 🎣 hooks/                   # Custom React hooks
│   │   ├── useAuth.ts              # Authentication state/methods
│   │   ├── useCart.ts              # Shopping cart state/methods
│   │   ├── useFetch.ts             # Fetch wrapper with caching
│   │   ├── useLocalStorage.ts      # LocalStorage state sync
│   │   ├── useDebounce.ts          # Debounced value
│   │   ├── useThrottle.ts          # Throttled callback
│   │   ├── useInfiniteScroll.ts    # Infinite scroll hook
│   │   ├── useMediaQuery.ts        # Responsive breakpoints
│   │   ├── useClickOutside.ts      # Close on outside click
│   │   ├── useMutation.ts          # POST/PATCH/DELETE wrapper
│   │   ├── useQuery.ts             # GET wrapper with caching
│   │   ├── useToast.ts             # Toast notification control
│   │   ├── useForm.ts              # Form state management
│   │   └── usePagination.ts        # Pagination logic
│   │
│   ├── 📚 types/                   # TypeScript type definitions
│   │   ├── index.ts                # Main types export
│   │   ├── models.ts               # Database models (Product, Order, etc.)
│   │   ├── api.ts                  # API request/response types
│   │   ├── auth.ts                 # Authentication types
│   │   ├── ui.ts                   # UI component prop types
│   │   └── errors.ts               # Error types
│   │
│   ├── 🛠 lib/                     # Utility functions
│   │   ├── api.ts                  # API client helpers
│   │   ├── auth.ts                 # Auth helpers (JWT parsing, etc.)
│   │   ├── db.ts                   # Database connection/helpers
│   │   ├── validation.ts           # Zod schemas for validation
│   │   ├── utils.ts                # General utilities (format, sort, etc.)
│   │   ├── constants.ts            # App-wide constants
│   │   ├── errors.ts               # Error classes
│   │   ├── cache.ts                # Caching utilities
│   │   ├── dates.ts                # Date formatting/calculation
│   │   ├── currency.ts             # Currency conversion/formatting
│   │   ├── image.ts                # Image optimization helpers
│   │   ├── slugify.ts              # URL slug generation
│   │   ├── seo.ts                  # SEO meta tag helpers
│   │   └── __tests__/
│   │       ├── validation.test.ts
│   │       ├── utils.test.ts
│   │       └── currency.test.ts
│   │
│   ├── 🗄 server/                  # Server-only code
│   │   ├── api/
│   │   │   ├── products.ts         # Product service (queries/mutations)
│   │   │   ├── orders.ts           # Order service
│   │   │   ├── cart.ts             # Cart service
│   │   │   ├── auth.ts             # Auth service
│   │   │   ├── customers.ts        # Customer service
│   │   │   ├── import.ts           # Import service
│   │   │   └── admin.ts            # Admin service
│   │   │
│   │   ├── db/
│   │   │   ├── client.ts           # Database client initialization
│   │   │   ├── schema.ts           # Database schema (Drizzle or SQL)
│   │   │   ├── queries.ts          # Reusable DB queries
│   │   │   ├── transactions.ts     # Transaction helpers
│   │   │   └── migrations/
│   │   │       ├── 001_init.sql
│   │   │       ├── 002_add_audit.sql
│   │   │       └── migration.ts    # Migration runner
│   │   │
│   │   ├── services/
│   │   │   ├── email.ts            # Email service (SendGrid)
│   │   │   ├── image.ts            # Image processing (Sharp, etc.)
│   │   │   ├── import.ts           # Product import service
│   │   │   ├── whatsapp.ts         # WhatsApp integration
│   │   │   └── stripe.ts           # Stripe integration (future)
│   │   │
│   │   ├── auth/
│   │   │   ├── jwt.ts              # JWT token generation/verification
│   │   │   ├── session.ts          # Session management
│   │   │   ├── password.ts         # Password hashing/verification
│   │   │   └── oauth.ts            # OAuth providers (future)
│   │   │
│   │   └── middleware/
│   │       ├── auth.ts             # Authentication middleware
│   │       ├── authorization.ts    # Role-based authorization
│   │       ├── logging.ts          # Request logging
│   │       ├── errorHandler.ts     # Global error handling
│   │       └── rateLimit.ts        # Rate limiting
│   │
│   └── 🎨 styles/                  # Global styles
│       ├── globals.css             # Global Tailwind imports
│       ├── animations.css          # Custom animations
│       ├── typography.css          # Font definitions
│       └── variables.css           # CSS variables (colors, spacing)
│
├── 📁 public/                      # Static assets
│   ├── images/
│   │   ├── logo.svg               # Brand logo
│   │   ├── logo-dark.svg
│   │   ├── hero/
│   │   │   └── homepage-hero.webp
│   │   ├── placeholder/
│   │   │   ├── product.png
│   │   │   └── user.svg
│   │   └── icons/
│   │       ├── search.svg
│   │       ├── cart.svg
│   │       ├── menu.svg
│   │       └── close.svg
│   ├── fonts/
│   │   ├── inter-var.woff2        # Primary font
│   │   └── playfair-var.woff2     # Display font
│   └── robots.txt
│
├── 📁 .claude/                     # Claude Code configuration
│   └── settings.json              # Claude Code settings
│
├── 📁 .github/                     # GitHub configuration
│   └── workflows/
│       ├── lint.yml               # ESLint on push
│       ├── test.yml               # Run tests on push
│       ├── build.yml              # Build check
│       └── deploy.yml             # Auto-deploy to staging/prod
│
├── 📁 database/                    # Database scripts
│   ├── migrations/
│   │   ├── 001_init.sql
│   │   ├── 002_add_audit.sql
│   │   └── 003_add_indexes.sql
│   ├── seeds/
│   │   ├── dev.sql               # Development data
│   │   └── categories.sql        # Category fixtures
│   └── backups/                  # Database backups (not in repo)
│
├── 📁 docs/                        # Additional documentation
│   ├── API.md                     # API documentation
│   ├── DEPLOYMENT.md              # Deployment guide
│   ├── SECURITY.md                # Security guidelines
│   ├── PERFORMANCE.md             # Performance guidelines
│   ├── TROUBLESHOOTING.md         # Common issues & fixes
│   ├── CONTRIBUTING.md            # Contribution guidelines
│   ├── ADMIN_GUIDE.md             # How to use admin dashboard
│   └── openapi.json               # OpenAPI/Swagger schema
│
├── 📁 scripts/                     # Development scripts
│   ├── setup.sh                   # Initial setup
│   ├── seed.sh                    # Seed database
│   ├── test.sh                    # Run tests
│   ├── lint.sh                    # Run linter
│   ├── migrate.sh                 # Run migrations
│   └── build.sh                   # Production build
│
├── 📁 e2e/                         # End-to-end tests
│   ├── checkout.spec.ts           # Checkout flow tests
│   ├── product.spec.ts            # Product browsing tests
│   ├── admin.spec.ts              # Admin operations tests
│   └── fixtures/
│       └── test-data.json         # Test data
│
└── 📁 node_modules/               # Dependencies (not in git)
```

---

## Key Organizational Principles

### 1. **Route Grouping** (Next.js 14 App Router)
```
(admin)/     → Admin routes, separate from shop
(shop)/      → Customer routes
```
- Grouping with parentheses doesn't affect URL structure
- Allows separate layouts without affecting routing
- Cleaner organization as app scales

### 2. **API Versioning**
```
/api/v1/     → Version 1 endpoints
/api/v2/     → Future: Version 2 with breaking changes
```
- Keep old versions for backward compatibility
- Migrate customers gradually
- Makes versioning explicit

### 3. **Admin vs Customer Separation**
```
Admin Code:     /src/components/admin/    (admin-only features)
                /app/(admin)/              (admin pages/routes)
                /src/server/               (server-side admin operations)

Customer Code:  /src/components/shop/     (customer features)
                /app/(shop)/               (customer pages)

Shared Code:    /src/components/shared/   (reusable components)
                /src/lib/                  (utility functions)
                /src/hooks/                (custom hooks)
```

### 4. **Server vs Client Code**
```
Server Code:    /src/server/               (only runs on server)
                /app/api/                  (API routes)
                
Client Code:    /src/components/           (React components)
                /src/hooks/                (React hooks)
                
Note: By default, Next.js 14 components are server components
Use 'use client' directive for client-side interactivity
```

### 5. **Colocation of Tests**
```
Feature:        ProductCard.tsx
Test:           ProductCard.test.tsx       (same folder)

Or alternatively:

Feature:        /src/components/shop/ProductCard.tsx
Tests:          /src/components/__tests__/ProductCard.test.tsx
```

---

## Adding New Features

### When adding a new admin feature:
```
1. Create API route: /src/app/api/v1/admin/feature/route.ts
2. Create database service: /src/server/api/feature.ts
3. Create admin page: /src/app/(admin)/feature/page.tsx
4. Create components: /src/components/admin/FeatureName.tsx
5. Create tests: /src/components/__tests__/FeatureName.test.tsx
6. Update types: /src/types/index.ts
```

### When adding a new customer feature:
```
1. Create API route: /src/app/api/v1/feature/route.ts
2. Create shop page: /src/app/(shop)/feature/page.tsx
3. Create components: /src/components/shop/FeatureName.tsx
4. Create hooks: /src/hooks/useFeature.ts (if needed)
5. Create tests: /src/components/__tests__/FeatureName.test.tsx
6. Update types: /src/types/index.ts
```

---

## Important Files Reference

| File | Purpose |
|------|---------|
| `/package.json` | Dependencies, scripts, metadata |
| `/tsconfig.json` | TypeScript configuration |
| `/next.config.js` | Next.js configuration |
| `/tailwind.config.ts` | Tailwind CSS configuration |
| `/.env.local` | Environment variables (local only, not in git) |
| `/src/types/index.ts` | All TypeScript type definitions |
| `/src/lib/validation.ts` | Zod validation schemas |
| `/src/server/db/schema.ts` | Database schema |
| `/ARCHITECTURE.md` | System architecture |
| `/DATABASE_SCHEMA.md` | Database design |
| `/CODING_STANDARDS.md` | Code style guidelines |

---

## Scalability Considerations

### As the product catalog grows:
- Pagination becomes essential (implement at `/api/v1/products?page=1&limit=20`)
- Caching strategy improves (Redis, Edge caching)
- Database indexes optimize (reviewed in DATABASE_SCHEMA.md)

### As admin team grows:
- Role-based access control (admin, moderator, viewer)
- Audit logging becomes critical (already designed in schema)
- Admin features get their own subsections

### As orders grow:
- Batch processing for imports (job queues)
- Async order processing (event-driven)
- Analytics materialized views

---

## Migration to This Structure

If migrating from existing structure:
```
1. Keep existing /src/app/api/orders/* (migrate gradually)
2. Add new /src/app/api/v1/* routes alongside
3. Update environment to point to new structures
4. Test new routes thoroughly
5. Migrate customer/admin code incrementally
6. Clean up old code once new code is stable
```

---

*Folder structure maintained in: `/FOLDER_STRUCTURE.md`*  
*Version 1.0 | Last Updated: May 2026*
