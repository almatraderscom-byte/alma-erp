# Coding Standards - Alma Lifestyle Ecommerce

**Version**: 1.0 | **Language**: TypeScript | **Framework**: Next.js 14  
**Philosophy**: Consistency over cleverness, readability over brevity

---

## File Organization

### Folder Structure
```
src/
├── app/
│   ├── (admin)/              # Admin routes, grouped
│   │   ├── layout.tsx
│   │   ├── dashboard/
│   │   ├── products/
│   │   ├── orders/
│   │   └── imports/
│   ├── (shop)/               # Customer routes, grouped
│   │   ├── layout.tsx
│   │   ├── page.tsx
│   │   ├── products/[slug]/
│   │   ├── collections/[slug]/
│   │   └── checkout/
│   ├── api/
│   │   ├── v1/
│   │   │   ├── auth/
│   │   │   ├── products/
│   │   │   ├── orders/
│   │   │   ├── cart/
│   │   │   ├── admin/
│   │   │   └── health/
│   │   └── middleware.ts
│   └── layout.tsx            # Root layout
├── components/
│   ├── admin/                # Admin-only components
│   │   ├── ProductForm.tsx
│   │   ├── ImportProgress.tsx
│   │   └── OrderList.tsx
│   ├── shop/                 # Customer-facing components
│   │   ├── ProductCard.tsx
│   │   ├── ImageGallery.tsx
│   │   └── CheckoutForm.tsx
│   └── shared/               # Used in both
│       ├── Header.tsx
│       ├── Footer.tsx
│       └── Toast.tsx
├── lib/
│   ├── api.ts                # API client helpers
│   ├── auth.ts               # Auth utilities
│   ├── db.ts                 # Database utilities
│   ├── validation.ts         # Zod schemas
│   └── utils.ts              # General utilities
├── hooks/
│   ├── useAuth.ts
│   ├── useCart.ts
│   └── useFetch.ts
├── types/
│   └── index.ts              # All TypeScript types
├── styles/
│   └── globals.css           # Global Tailwind
├── env/
│   └── schema.ts             # Environment variable schema
└── server/
    ├── api/
    │   ├── products.ts
    │   ├── orders.ts
    │   └── db/
    │       └── queries.ts
    └── db/
        ├── schema.ts         # Drizzle or raw SQL
        └── migrations/

public/
├── images/
│   ├── logo.svg
│   └── hero.webp
└── icons/
```

---

## TypeScript Standards

### Type Definitions
```typescript
// ✅ GOOD: Explicit, self-documenting
interface Product {
  id: UUID;
  title: string;
  price: Money;
  stock: InventoryLevel;
  publishedAt: ISODate | null;
}

// ✅ GOOD: Use brands for primitive types
type UUID = string & { readonly __brand: "UUID" };
type Money = number & { readonly __brand: "Money" };
type ISODate = string & { readonly __brand: "ISODate" };

// ❌ BAD: Any types
const product: any = data;

// ❌ BAD: Overly generic
interface Data {
  id: string;
  data: Record<string, any>;
}
```

### Type Organization
```typescript
// types/index.ts - single source of truth for all types
export interface Product { ... }
export interface Order { ... }
export interface Customer { ... }
export type APIResponse<T> = { status: 'success' | 'error'; data?: T; error?: string; }
export type OrderStatus = 'pending_payment' | 'confirmed' | 'shipped' | 'delivered';

// Don't scatter types across files
```

### Strict Mode
```typescript
// tsconfig.json
{
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "strictFunctionTypes": true,
    "strictPropertyInitialization": true
  }
}
```

---

## React Component Standards

### Functional Components Only
```typescript
// ✅ GOOD: Functional component with clear props
interface ProductCardProps {
  product: Product;
  onAddToCart: (productId: UUID) => Promise<void>;
  isLoading?: boolean;
}

export function ProductCard({ product, onAddToCart, isLoading }: ProductCardProps) {
  return (
    <div className="...">
      <h2>{product.title}</h2>
      <p>${product.price}</p>
      <button onClick={() => onAddToCart(product.id)}>
        {isLoading ? 'Adding...' : 'Add to Cart'}
      </button>
    </div>
  );
}

// ❌ BAD: Class components
class ProductCard extends React.Component { ... }

// ❌ BAD: Inline handler
<button onClick={() => addToCart(product.id)}>Add</button>
// Pass to parent or useCallback instead
```

### Component Naming
```typescript
// ✅ GOOD: Clear, descriptive names
export function ProductImageGallery() { ... }
export function CheckoutShippingForm() { ... }
export function AdminOrderStatusBadge() { ... }

// ❌ BAD: Too generic
export function Gallery() { ... }
export function Form() { ... }
export function Badge() { ... }
```

### Props Destructuring
```typescript
// ✅ GOOD: Full typing, clear what's used
interface Props {
  productId: UUID;
  quantity: number;
  onUpdate: (quantity: number) => void;
}

export function QuantitySelector({ productId, quantity, onUpdate }: Props) {
  return (
    <input 
      value={quantity} 
      onChange={(e) => onUpdate(parseInt(e.target.value))}
    />
  );
}

// ❌ BAD: Implicit any
export function QuantitySelector(props) { ... }

// ❌ BAD: Spreading all props
export function QuantitySelector({ ...props }) { ... }
```

### Hooks Usage
```typescript
// ✅ GOOD: Custom hooks for business logic
function useCart() {
  const [items, setItems] = useState<CartItem[]>([]);
  
  const addItem = useCallback((item: CartItem) => {
    setItems(prev => [...prev, item]);
  }, []);
  
  return { items, addItem };
}

// ✅ GOOD: useEffect with dependency array
useEffect(() => {
  // Subscribe to something
  return () => {
    // Cleanup
  };
}, [dependency]);

// ❌ BAD: Empty dependency array when there are dependencies
useEffect(() => {
  fetchProduct(productId);
}, []); // Missing productId

// ❌ BAD: Logic in component body without memoization
const handleClick = () => doSomething(); // Recreated every render
```

---

## API Route Standards

### Route Organization
```typescript
// app/api/v1/products/route.ts - GET and POST in same file
export async function GET(req: Request) {
  // GET /api/v1/products
}

export async function POST(req: Request) {
  // POST /api/v1/products
}

// app/api/v1/products/[id]/route.ts - Dynamic routes
export async function GET(
  req: Request,
  { params }: { params: { id: UUID } }
) {
  // GET /api/v1/products/:id
}

export async function PATCH(
  req: Request,
  { params }: { params: { id: UUID } }
) {
  // PATCH /api/v1/products/:id
}
```

### Standard Response Format
```typescript
// ✅ GOOD: Consistent, predictable
interface APISuccess<T> {
  status: 'success';
  data: T;
}

interface APIError {
  status: 'error';
  code: string; // 'ERR_VALIDATION', 'ERR_NOT_FOUND', etc
  message: string;
  details?: Record<string, string>; // Field-level errors
}

type APIResponse<T> = APISuccess<T> | APIError;

// Usage:
export async function GET(req: Request): Promise<Response> {
  try {
    const product = await getProduct(productId);
    if (!product) {
      return Response.json(
        { status: 'error', code: 'ERR_NOT_FOUND', message: 'Product not found' },
        { status: 404 }
      );
    }
    return Response.json({ status: 'success', data: product });
  } catch (err) {
    return Response.json(
      { status: 'error', code: 'ERR_INTERNAL', message: 'Internal server error' },
      { status: 500 }
    );
  }
}
```

### Input Validation with Zod
```typescript
// lib/validation.ts
import { z } from 'zod';

export const CreateProductSchema = z.object({
  title: z.string().min(5).max(255),
  price: z.number().positive(),
  category: z.string().uuid(),
  description: z.string().optional(),
});

// app/api/v1/products/route.ts
export async function POST(req: Request) {
  const body = await req.json();
  
  const validation = CreateProductSchema.safeParse(body);
  if (!validation.success) {
    return Response.json(
      {
        status: 'error',
        code: 'ERR_VALIDATION',
        message: 'Invalid product data',
        details: validation.error.flatten().fieldErrors,
      },
      { status: 400 }
    );
  }
  
  // validation.data is now typed correctly
  const product = await createProduct(validation.data);
  return Response.json({ status: 'success', data: product });
}
```

### Error Handling
```typescript
// ✅ GOOD: Specific error classes
class ValidationError extends Error {
  code = 'ERR_VALIDATION';
  fields: Record<string, string>;
  
  constructor(fields: Record<string, string>) {
    super('Validation failed');
    this.fields = fields;
  }
}

class NotFoundError extends Error {
  code = 'ERR_NOT_FOUND';
  constructor(entity: string, id: string) {
    super(`${entity} with id ${id} not found`);
  }
}

// ✅ GOOD: Error handling in route
export async function GET(req: Request) {
  try {
    return await getProductSafely(productId);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return Response.json(
        { status: 'error', code: err.code, message: err.message },
        { status: 404 }
      );
    }
    if (err instanceof ValidationError) {
      return Response.json(
        { status: 'error', code: err.code, message: err.message, details: err.fields },
        { status: 400 }
      );
    }
    // Unexpected error
    console.error('Unexpected error:', err);
    return Response.json(
      { status: 'error', code: 'ERR_INTERNAL', message: 'Internal server error' },
      { status: 500 }
    );
  }
}
```

---

## Database Standards

### Query Patterns
```typescript
// ✅ GOOD: Use parameterized queries (prevent SQL injection)
const product = await db.query(
  'SELECT * FROM products WHERE id = $1',
  [productId]
);

// ✅ GOOD: Use ORM (Drizzle, Prisma) when possible
const product = await db.select().from(products).where(eq(products.id, productId));

// ❌ BAD: String interpolation
const product = await db.query(`SELECT * FROM products WHERE id = '${productId}'`);
```

### Transaction Handling
```typescript
// ✅ GOOD: Explicit transaction boundaries
async function createOrderWithItems(order, items) {
  return await db.transaction(async (tx) => {
    const createdOrder = await tx.insert(orders).values(order);
    await tx.insert(orderItems).values(items);
    return createdOrder;
  });
}

// ✅ GOOD: Rollback on error
try {
  await createOrderWithItems(order, items);
} catch (err) {
  // Transaction rolled back automatically
  throw err;
}
```

### Indexes for Common Queries
```sql
-- Product listing (by category, published)
CREATE INDEX idx_products_published ON products(published, category_id, created_at DESC);

-- Orders by customer
CREATE INDEX idx_orders_customer ON orders(customer_id, created_at DESC);

-- Order items by order
CREATE INDEX idx_order_items_order ON order_items(order_id);

-- Searches
CREATE INDEX idx_products_title ON products USING gin(to_tsvector('english', title));
```

---

## Naming Conventions

### Variables & Functions
```typescript
// ✅ GOOD: camelCase for variables and functions
const isLoading = false;
const productId = '123';
function handleAddToCart(productId: UUID) { ... }
function getProductById(id: UUID) { ... }

// ✅ GOOD: Boolean prefixes
const isVisible = true;
const hasError = false;
const canDelete = true;
const isLoading = false;

// ✅ GOOD: Verb prefixes for functions
function get...() { }
function create...() { }
function update...() { }
function delete...() { }
function format...() { }
function validate...() { }
function parse...() { }

// ❌ BAD: Hungarian notation
const strName = 'Product';
const arrItems = [];
const boolActive = true;

// ❌ BAD: Unclear names
const x = products;
const temp = calculateTotal();
const data = fetchFromServer();
```

### Constants
```typescript
// ✅ GOOD: UPPER_SNAKE_CASE for constants
export const MAX_PRODUCT_TITLE_LENGTH = 255;
export const CART_EXPIRY_DAYS = 30;
export const API_RATE_LIMIT = 1000;

// ✅ GOOD: Enums instead of magic strings
export enum OrderStatus {
  PENDING_PAYMENT = 'pending_payment',
  CONFIRMED = 'confirmed',
  SHIPPED = 'shipped',
  DELIVERED = 'delivered',
}

// ✅ GOOD: Group related constants
export const IMAGES = {
  THUMBNAIL_WIDTH: 150,
  THUMBNAIL_HEIGHT: 200,
  PRODUCT_LIST_WIDTH: 300,
  PRODUCT_LIST_HEIGHT: 400,
} as const;

export const CURRENCY = {
  USD: 'USD',
  AED: 'AED',
  BDT: 'BDT',
} as const;

// ❌ BAD: Magic strings
const status = 'pending_payment'; // Use enum
const maxLength = 255; // Use constant
```

---

## Testing Standards

### Unit Tests
```typescript
// lib/__tests__/validation.test.ts
import { describe, it, expect } from 'vitest';
import { validateProductPrice } from '../validation';

describe('validateProductPrice', () => {
  it('accepts positive prices', () => {
    expect(validateProductPrice(19.99)).toBe(true);
  });

  it('rejects negative prices', () => {
    expect(validateProductPrice(-10)).toBe(false);
  });

  it('rejects zero', () => {
    expect(validateProductPrice(0)).toBe(false);
  });
});
```

### Integration Tests
```typescript
// app/api/v1/products/__tests__/route.test.ts
import { describe, it, expect } from 'vitest';
import { POST } from '../route';

describe('POST /api/v1/products', () => {
  it('creates product with valid data', async () => {
    const req = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Premium Kurti',
        price: 49.99,
        category: validCategoryId,
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('success');
    expect(data.data.id).toBeDefined();
  });

  it('rejects invalid data', async () => {
    const req = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ title: '' }), // Missing required fields
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});
```

### E2E Tests (Critical Paths)
```typescript
// e2e/checkout.spec.ts
import { test, expect } from '@playwright/test';

test('complete checkout flow', async ({ page }) => {
  // Browse product
  await page.goto('/products/premium-kurti');
  await expect(page.locator('h1')).toContainText('Premium Kurti');
  
  // Add to cart
  await page.click('button:has-text("Add to Cart")');
  await expect(page.locator('[data-testid="cart-count"]')).toHaveText('1');
  
  // Checkout
  await page.click('[data-testid="checkout-button"]');
  await page.fill('input[name="email"]', 'test@example.com');
  await page.click('button:has-text("Place Order")');
  
  // Confirm order
  await expect(page).toHaveURL(/\/order-confirmation/);
  await expect(page.locator('[data-testid="order-number"]')).toBeDefined();
});
```

---

## Git & Commit Standards

### Commit Messages
```
Format: <type>: <subject>

<body>

Fixes #<issue-number>

---

type: feat, fix, refactor, docs, test, perf, style, chore
subject: Imperative, lowercase, ≤50 characters
body: Explain what and why (≤72 chars per line)
```

### Examples
```
✅ GOOD:
feat: add product import from URL

Implement bulk importer that fetches products from supplier URLs.
Uses retry logic for network failures and validates all required fields.
Images are downloaded and optimized before storage.

Fixes #234

---

✅ GOOD:
fix: prevent cart overselling when stock updates

Reserve stock quantity when order created, release on cancellation.
Prevents race condition when concurrent orders placed simultaneously.

Fixes #567

---

❌ BAD:
Updated stuff

❌ BAD:
fix bug in checkout

❌ BAD:
wip: work in progress
```

### Branch Naming
```
feature/add-product-importer
feature/checkout-integration

bugfix/cart-overselling-issue
bugfix/image-upload-timeout

refactor/extract-validation-logic

docs/api-documentation

Type/description-of-work
```

---

## Performance Standards

### Code Splitting
```typescript
// ✅ GOOD: Dynamic imports for large components
import dynamic from 'next/dynamic';

const AdminDashboard = dynamic(() => import('./AdminDashboard'), {
  loading: () => <LoadingSpinner />,
});

// ✅ GOOD: Route-based code splitting (automatic in Next.js)
// app/admin/page.tsx - Only loaded when admin route accessed
// app/shop/page.tsx - Only loaded when shop route accessed
```

### Memoization
```typescript
// ✅ GOOD: Memoize expensive computations
function useCalculatedTotal(items: CartItem[]) {
  return useMemo(() => {
    return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  }, [items]);
}

// ✅ GOOD: Memoize callbacks
function ProductList({ onSelectProduct }: Props) {
  const handleSelect = useCallback((id: UUID) => {
    onSelectProduct(id);
  }, [onSelectProduct]);
  
  return <div>{/* ... */}</div>;
}

// ❌ BAD: Unnecessary memoization
const count = useMemo(() => 1 + 1, []); // Too simple, cache overhead not worth it
```

---

## Accessibility Standards

### HTML & ARIA
```typescript
// ✅ GOOD: Semantic HTML
<button onClick={handleAddToCart}>Add to Cart</button>
<nav>
  <a href="/">Home</a>
  <a href="/products">Products</a>
</nav>

// ✅ GOOD: ARIA labels when needed
<button aria-label="Close cart drawer" onClick={handleClose}>
  <X />
</button>

<div role="status" aria-live="polite">
  {message}
</div>

// ❌ BAD: Divs as buttons
<div onClick={handleAddToCart}>Add to Cart</div>

// ❌ BAD: Missing alt text
<img src="/product.jpg" />
```

---

## Documentation Standards

### JSDoc Comments
```typescript
// ✅ GOOD: Document complex functions
/**
 * Calculate total price including tax and shipping.
 * 
 * @param items - Cart items to calculate for
 * @param shippingMethod - Shipping method (standard, express, overnight)
 * @param taxRate - Tax rate as decimal (0.1 = 10%)
 * @returns Total price in dollars, rounded to 2 decimals
 * 
 * @example
 * const total = calculateTotal(items, 'standard', 0.1);
 * // Returns: 125.99
 */
function calculateTotal(
  items: CartItem[],
  shippingMethod: 'standard' | 'express' | 'overnight',
  taxRate: number
): number {
  // Implementation
}

// ❌ BAD: Obvious comments
// Get the product ID
const productId = product.id;

// Increment counter
count++;
```

### README Standards
```markdown
# Feature Name

## Description
One sentence describing what this does and why.

## Usage
Code example showing how to use.

## API
List of exported functions/types.

## Tests
How to run tests for this module.
```

---

## Code Review Checklist

- [ ] Follows TypeScript strict mode
- [ ] No `any` types without explanation
- [ ] All functions/components documented
- [ ] Error handling present and tested
- [ ] No console.log in production code
- [ ] Tests written for all logic
- [ ] No hardcoded values (use constants)
- [ ] Performance implications considered
- [ ] Accessibility checked
- [ ] No security vulnerabilities
- [ ] Naming clear and consistent
- [ ] DRY principle followed
- [ ] No dead code or commented code

---

*Coding standards maintained in: `/CODING_STANDARDS.md`*  
*Version 1.0 | Last Updated: May 2026*
