# Database Schema - Alma Lifestyle Ecommerce

**Version**: 1.0 | **DBMS**: PostgreSQL 14+ (Supabase)  
**Design Philosophy**: Normalize for integrity, denormalize for performance

---

## Core Tables

### 1. `brands`
For future multi-brand support. Currently: single "alma-lifestyle" record.

```sql
CREATE TABLE brands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug VARCHAR(50) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  logo_url VARCHAR(255),
  website_url VARCHAR(255),
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

-- Currently: INSERT INTO brands (slug, name) VALUES ('alma-lifestyle', 'Alma Lifestyle');
```

---

### 2. `categories`
Product categorization. Example: "Kurtis", "Sarees", "Dupattas"

```sql
CREATE TABLE categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id UUID NOT NULL REFERENCES brands(id),
  slug VARCHAR(100) NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  image_url VARCHAR(255),
  parent_id UUID REFERENCES categories(id),
  display_order INT DEFAULT 0,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now(),
  UNIQUE(brand_id, slug)
);

-- Indexes
CREATE INDEX idx_categories_brand ON categories(brand_id);
CREATE INDEX idx_categories_parent ON categories(parent_id);
CREATE INDEX idx_categories_active ON categories(active, brand_id);
```

---

### 3. `collections`
Curated groups of products. Example: "Summer Essentials", "Wedding Special"

```sql
CREATE TABLE collections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id UUID NOT NULL REFERENCES brands(id),
  slug VARCHAR(100) NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  hero_image_url VARCHAR(255),
  hero_image_alt VARCHAR(255),
  sort_order INT DEFAULT 0,
  published BOOLEAN DEFAULT false,
  published_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now(),
  UNIQUE(brand_id, slug)
);

-- Indexes
CREATE INDEX idx_collections_brand ON collections(brand_id);
CREATE INDEX idx_collections_published ON collections(published, brand_id);
```

---

### 4. `collection_products`
Join table for products in collections (many-to-many, ordered)

```sql
CREATE TABLE collection_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sort_order INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT now(),
  UNIQUE(collection_id, product_id)
);

-- Indexes
CREATE INDEX idx_collection_products_collection ON collection_products(collection_id);
CREATE INDEX idx_collection_products_product ON collection_products(product_id);
```

---

### 5. `products`
Core product catalog. Immutable after initial import (prefer versioning/snapshots).

```sql
CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id UUID NOT NULL REFERENCES brands(id),
  category_id UUID NOT NULL REFERENCES categories(id),
  sku VARCHAR(100) NOT NULL,
  slug VARCHAR(255) NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  price_usd DECIMAL(10, 2) NOT NULL,
  price_aed DECIMAL(10, 2) NOT NULL,
  price_bdt DECIMAL(10, 2) NOT NULL,
  cost_usd DECIMAL(10, 2),
  weight_kg DECIMAL(5, 2),
  fabric VARCHAR(100),
  care_instructions TEXT,
  origin_country VARCHAR(2),
  published BOOLEAN DEFAULT false,
  published_at TIMESTAMP,
  
  -- Import tracking
  import_source_url VARCHAR(500),
  import_source_name VARCHAR(100),
  imported_at TIMESTAMP,
  
  -- Metadata
  seo_title VARCHAR(255),
  seo_description VARCHAR(500),
  seo_keywords VARCHAR(500),
  
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now(),
  UNIQUE(brand_id, sku),
  UNIQUE(brand_id, slug)
);

-- Indexes
CREATE INDEX idx_products_brand ON products(brand_id);
CREATE INDEX idx_products_category ON products(category_id);
CREATE INDEX idx_products_published ON products(published, brand_id, published_at DESC);
CREATE INDEX idx_products_sku ON products(sku);
CREATE INDEX idx_products_slug ON products(slug);
CREATE INDEX idx_products_imported_at ON products(imported_at DESC);
```

---

### 6. `product_variants`
Size, color, quantity combinations for a product.

```sql
CREATE TABLE product_variants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku VARCHAR(100) NOT NULL,
  size VARCHAR(50),
  color VARCHAR(50),
  stock_quantity INT DEFAULT 0,
  reserved_quantity INT DEFAULT 0,
  sku_variant VARCHAR(100),
  display_name VARCHAR(255),
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now(),
  UNIQUE(product_id, sku),
  UNIQUE(product_id, size, color)
);

-- Indexes
CREATE INDEX idx_variants_product ON product_variants(product_id);
CREATE INDEX idx_variants_sku ON product_variants(sku);
```

---

### 7. `product_images`
Multiple images per product. First image = featured/hero image.

```sql
CREATE TABLE product_images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id UUID REFERENCES product_variants(id) ON DELETE SET NULL,
  url VARCHAR(500) NOT NULL,
  alt_text VARCHAR(255),
  sort_order INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT now(),
  UNIQUE(product_id, url)
);

-- Indexes
CREATE INDEX idx_product_images_product ON product_images(product_id);
CREATE INDEX idx_product_images_variant ON product_images(variant_id);
```

---

## Order & Cart Tables

### 8. `orders`
Core order entity. Status progression: pending_payment → confirmed → shipped → delivered

```sql
CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id UUID NOT NULL REFERENCES brands(id),
  order_number VARCHAR(50) UNIQUE NOT NULL,
  customer_id UUID REFERENCES customers(id),
  
  -- Customer details (denormalized for order immutability)
  customer_name VARCHAR(255) NOT NULL,
  customer_email VARCHAR(255),
  customer_phone VARCHAR(20) NOT NULL,
  
  -- Shipping
  shipping_address TEXT NOT NULL,
  shipping_city VARCHAR(100),
  shipping_country VARCHAR(2),
  shipping_postal_code VARCHAR(20),
  
  -- Billing
  billing_same_as_shipping BOOLEAN DEFAULT true,
  billing_address TEXT,
  billing_city VARCHAR(100),
  billing_country VARCHAR(2),
  billing_postal_code VARCHAR(20),
  
  -- Pricing
  subtotal_usd DECIMAL(10, 2) NOT NULL,
  shipping_cost_usd DECIMAL(10, 2) DEFAULT 0,
  tax_usd DECIMAL(10, 2) DEFAULT 0,
  discount_usd DECIMAL(10, 2) DEFAULT 0,
  total_usd DECIMAL(10, 2) NOT NULL,
  
  -- Status
  status VARCHAR(50) DEFAULT 'pending_payment',
  payment_method VARCHAR(50),
  notes TEXT,
  
  -- Tracking
  tracking_number VARCHAR(100),
  carrier VARCHAR(50),
  
  -- Metadata
  currency VARCHAR(3) DEFAULT 'USD',
  source VARCHAR(50),
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now(),
  shipped_at TIMESTAMP,
  delivered_at TIMESTAMP
);

-- Indexes
CREATE INDEX idx_orders_brand ON orders(brand_id);
CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_status ON orders(status, created_at DESC);
CREATE INDEX idx_orders_order_number ON orders(order_number);
CREATE INDEX idx_orders_created_at ON orders(created_at DESC);
```

---

### 9. `order_items`
Line items in an order. Immutable snapshot of product state.

```sql
CREATE TABLE order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id),
  variant_id UUID REFERENCES product_variants(id),
  
  -- Snapshot (immutable)
  product_sku VARCHAR(100) NOT NULL,
  product_title VARCHAR(255) NOT NULL,
  variant_size VARCHAR(50),
  variant_color VARCHAR(50),
  unit_price_usd DECIMAL(10, 2) NOT NULL,
  quantity INT NOT NULL,
  discount_usd DECIMAL(10, 2) DEFAULT 0,
  total_usd DECIMAL(10, 2) NOT NULL,
  
  created_at TIMESTAMP DEFAULT now()
);

-- Indexes
CREATE INDEX idx_order_items_order ON order_items(order_id);
CREATE INDEX idx_order_items_product ON order_items(product_id);
```

---

### 10. `cart_sessions`
Temporary shopping cart storage. Expires after 30 days of inactivity.

```sql
CREATE TABLE cart_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id UUID NOT NULL REFERENCES brands(id),
  customer_id UUID REFERENCES customers(id),
  session_token VARCHAR(255) UNIQUE,
  
  data JSONB,
  
  created_at TIMESTAMP DEFAULT now(),
  last_accessed_at TIMESTAMP DEFAULT now(),
  expires_at TIMESTAMP DEFAULT now() + INTERVAL '30 days'
);

-- Indexes
CREATE INDEX idx_cart_sessions_customer ON cart_sessions(customer_id);
CREATE INDEX idx_cart_sessions_token ON cart_sessions(session_token);
CREATE INDEX idx_cart_sessions_expires ON cart_sessions(expires_at);
```

---

## Customer Tables

### 11. `customers`
Registered customer accounts.

```sql
CREATE TABLE customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id UUID NOT NULL REFERENCES brands(id),
  email VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255),
  first_name VARCHAR(100),
  last_name VARCHAR(100),
  phone VARCHAR(20),
  
  -- Preferences
  preferred_currency VARCHAR(3) DEFAULT 'USD',
  preferred_language VARCHAR(5) DEFAULT 'en',
  marketing_opted_in BOOLEAN DEFAULT false,
  
  -- Status
  email_verified BOOLEAN DEFAULT false,
  email_verified_at TIMESTAMP,
  active BOOLEAN DEFAULT true,
  
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now(),
  last_login_at TIMESTAMP,
  UNIQUE(brand_id, email)
);

-- Indexes
CREATE INDEX idx_customers_brand ON customers(brand_id);
CREATE INDEX idx_customers_email ON customers(email);
```

---

### 12. `customer_addresses`
Multiple addresses per customer (shipping preferences).

```sql
CREATE TABLE customer_addresses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  
  label VARCHAR(50),
  address_line_1 VARCHAR(255) NOT NULL,
  address_line_2 VARCHAR(255),
  city VARCHAR(100) NOT NULL,
  state_province VARCHAR(100),
  postal_code VARCHAR(20),
  country VARCHAR(2) NOT NULL,
  phone VARCHAR(20),
  
  is_default BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

-- Indexes
CREATE INDEX idx_customer_addresses_customer ON customer_addresses(customer_id);
```

---

## Admin & Audit Tables

### 13. `import_logs`
Track product imports for debugging and auditing.

```sql
CREATE TABLE import_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id UUID NOT NULL REFERENCES brands(id),
  
  import_batch_id VARCHAR(100),
  source_name VARCHAR(100),
  source_type VARCHAR(50),
  
  status VARCHAR(50),
  total_products INT,
  successful_count INT DEFAULT 0,
  failed_count INT DEFAULT 0,
  
  error_details JSONB,
  started_at TIMESTAMP DEFAULT now(),
  completed_at TIMESTAMP,
  
  created_by UUID,
  created_at TIMESTAMP DEFAULT now()
);

-- Indexes
CREATE INDEX idx_import_logs_brand ON import_logs(brand_id);
CREATE INDEX idx_import_logs_status ON import_logs(status);
CREATE INDEX idx_import_logs_created_at ON import_logs(created_at DESC);
```

---

### 14. `audit_logs`
Immutable record of all admin operations.

```sql
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id UUID NOT NULL REFERENCES brands(id),
  
  entity_type VARCHAR(50) NOT NULL,
  entity_id UUID NOT NULL,
  action VARCHAR(50) NOT NULL,
  
  old_values JSONB,
  new_values JSONB,
  
  admin_id UUID,
  admin_ip VARCHAR(45),
  user_agent VARCHAR(500),
  
  created_at TIMESTAMP DEFAULT now()
);

-- Indexes
CREATE INDEX idx_audit_logs_brand ON audit_logs(brand_id);
CREATE INDEX idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX idx_audit_logs_admin ON audit_logs(admin_id);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at DESC);
```

---

## Query Performance Views (Future)

```sql
-- Popular products view
CREATE VIEW popular_products AS
SELECT 
  p.id,
  p.title,
  COUNT(oi.id) as order_count,
  SUM(oi.quantity) as units_sold
FROM products p
LEFT JOIN order_items oi ON p.id = oi.product_id
LEFT JOIN orders o ON oi.order_id = o.id
WHERE o.created_at > now() - INTERVAL '30 days'
GROUP BY p.id, p.title
ORDER BY order_count DESC;

-- Low stock alerts
CREATE VIEW low_stock_products AS
SELECT 
  p.id,
  p.sku,
  p.title,
  pv.size,
  pv.color,
  pv.stock_quantity
FROM products p
LEFT JOIN product_variants pv ON p.id = pv.product_id
WHERE pv.stock_quantity < 5
AND p.published = true;
```

---

## Data Constraints & Rules

### Referential Integrity
- **Cascade deletes**: categories → products → variants → images
- **Cascade deletes**: collections → collection_products
- **Restrict deletes**: brands (cannot delete if products exist)
- **On delete set null**: customer → orders (soft delete pattern)

### Domain Rules
```
1. Every product must have ≥1 variant
2. Every variant must have ≥1 image
3. Products cannot be published without category
4. Orders are immutable (no updates after creation, only status changes)
5. Stock = stock_quantity - reserved_quantity (calculated, not stored)
6. Prices in 3 currencies (USD is primary, AED/BDT calculated or manual)
```

### Audit Trail
```
- All tables have created_at, updated_at
- Admin operations logged to audit_logs
- Import operations logged to import_logs
- Orders ship date/delivery date tracked
- Customer email verification tracked
```

---

## Seeding Data (Development)

```sql
-- Brand
INSERT INTO brands (slug, name) VALUES ('alma-lifestyle', 'Alma Lifestyle');

-- Categories
INSERT INTO categories (brand_id, slug, name) VALUES
  ((SELECT id FROM brands WHERE slug='alma-lifestyle'), 'kurtis', 'Kurtis'),
  ((SELECT id FROM brands WHERE slug='alma-lifestyle'), 'sarees', 'Sarees'),
  ((SELECT id FROM brands WHERE slug='alma-lifestyle'), 'dupattas', 'Dupattas');

-- Collections
INSERT INTO collections (brand_id, slug, name, published) VALUES
  ((SELECT id FROM brands WHERE slug='alma-lifestyle'), 'summer-essentials', 'Summer Essentials', true),
  ((SELECT id FROM brands WHERE slug='alma-lifestyle'), 'wedding-special', 'Wedding Special', true);
```

---

## Migration Strategy

### Phase 1: Initial Setup
- Create all tables with constraints
- Add indexes
- Create views
- Seed base data

### Phase 2: Import Integration
- Connect import system
- Validate schema with live data
- Optimize slow queries
- Add missing indexes

### Phase 3: Order Processing
- Test order creation flows
- Verify inventory calculations
- Test audit logging
- Stress test with bulk orders

### Phase 4: Analytics
- Create materialized views for reporting
- Add summary tables for dashboard
- Implement data warehouse queries

---

## Backup & Recovery

```
Daily automated backups:
├── Full backup (nightly)
├── Incremental backups (hourly)
└── Point-in-time recovery (14 days)

Disaster recovery:
├── Backup region: secondary PostgreSQL
├── RPO: 1 hour
├── RTO: 15 minutes
└── Test recoveries monthly
```

---

*Schema maintained in: `/DATABASE_SCHEMA.md`*  
*Version 1.0 | Last Updated: May 2026*
