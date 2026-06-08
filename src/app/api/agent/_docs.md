# ALMA Agent API — Full Admin Reference

**Base URL:** `https://alma-erp-six.vercel.app/api/agent`  
**Auth header:** `X-ALMA-API-KEY: <ALMA_AGENT_API_KEY>` (same as Hermes `ALMA_ERP_API_KEY`)  
**IP allowlist:** Hermes VPS `31.97.237.40` (production default)  
**Rate limit:** 30 req/sec per IP  
**Write actor:** All POST/PATCH/DELETE log `agent_via_sir` to `AgentAuditLog`

## Response shape

- **Lists:** `{ data: { items..., meta: { count, ... } } }`
- **Singleton:** `{ data: { ... } }`
- **Writes:** `{ id, status, ... }` + audit log entry

## Endpoints (55 total)

### Employees & attendance (10)
| Method | Path | Type |
|--------|------|------|
| GET | `/employees` | read |
| GET | `/employees/:id` | read |
| POST | `/employees` | write |
| PATCH | `/employees/:id` | write |
| DELETE | `/employees/:id` | write (soft) |
| GET | `/attendance/today` | read |
| GET | `/attendance/history?employee_id=&days=` | read |
| POST | `/attendance/manual` | write |
| PATCH | `/attendance/:id` | write |
| DELETE | `/attendance/:id` | write (archive) |

### Tasks (7)
| GET | `/tasks` | read |
| GET | `/tasks/:id` | read |
| POST | `/tasks` | write |
| PATCH | `/tasks/:id` | write |
| POST | `/tasks/:id/complete` | write |
| POST | `/tasks/:id/cancel` | write |
| DELETE | `/tasks/:id` | write |

### Fines (7)
| GET | `/fines` | read |
| GET | `/fines/pending` | read |
| POST | `/fines` | write |
| POST | `/fines/:id/approve` | write |
| POST | `/fines/:id/waive` | write |
| DELETE | `/fines/:id` | write |

### Products (8)
| GET | `/products` | read |
| GET | `/products/:id` | read |
| GET | `/products/low-stock` | read |
| POST | `/products` | write |
| PATCH | `/products/:id` | write |
| PATCH | `/products/:id/pricing` | write |
| PATCH | `/products/:id/inventory` | write |
| DELETE | `/products/:id` | write (archive) |

### Inventory (4)
| GET | `/inventory` | read |
| GET | `/inventory/:product_id` | read |
| POST | `/inventory/adjust` | write |
| GET | `/inventory/movements` | read |

### Orders — Phase 5 + writes (8)
| GET | `/orders` | read (existing) |
| GET | `/orders/summary?period=` | read (existing) |
| GET | `/orders/:id` | read (existing) |
| GET | `/orders/today/live` | read |
| POST | `/orders/:id/cancel` | write |
| POST | `/orders/:id/refund` | write |
| PATCH | `/orders/:id/status` | write |
| POST | `/orders/:id/note` | write |

### Customers (8)
| GET | `/customers` | read |
| GET | `/customers/:id` | read |
| GET | `/customers/:id/orders` | read |
| POST | `/customers` | write |
| PATCH | `/customers/:id` | write |
| POST | `/customers/:id/note` | write |
| POST | `/customers/:id/tag` | write |
| DELETE | `/customers/:id/tag/:tag` | write |

### Promos (5)
| GET | `/promos` | read |
| POST | `/promos` | write |
| PATCH | `/promos/:id` | write |
| POST | `/promos/:id/deactivate` | write |
| DELETE | `/promos/:id` | write |

### Reports (5) — read only
| GET | `/reports/sales` | read |
| GET | `/reports/inventory` | read |
| GET | `/reports/customers` | read |
| GET | `/reports/employees` | read |
| GET | `/reports/finance` | read |

### Settings (5)
| GET | `/settings` | read |
| PATCH | `/settings/business-hours` | write |
| PATCH | `/settings/holidays` | write |
| PATCH | `/settings/late-threshold` | write |
| PATCH | `/settings/fine-policy` | write |

### Audit (2) — read only
| GET | `/audit/recent?limit=` | read |
| GET | `/audit/by-action?action=&limit=` | read |

## Sample curls

```bash
export KEY='your-alma-agent-api-key'
export BASE='https://alma-erp-six.vercel.app/api/agent'

curl -sS -H "X-ALMA-API-KEY: $KEY" "$BASE/employees?active=true&limit=5" | jq .
curl -sS -H "X-ALMA-API-KEY: $KEY" "$BASE/attendance/today" | jq .
curl -sS -H "X-ALMA-API-KEY: $KEY" "$BASE/tasks?status=pending" | jq .
curl -sS -H "X-ALMA-API-KEY: $KEY" "$BASE/fines/pending" | jq .
curl -sS -H "X-ALMA-API-KEY: $KEY" "$BASE/products" | jq .
curl -sS -H "X-ALMA-API-KEY: $KEY" "$BASE/orders/summary?period=today" | jq .
curl -sS -H "X-ALMA-API-KEY: $KEY" "$BASE/audit/recent?limit=5" | jq .
```

## Data sources (column mapping)

| Resource | Source | Key columns |
|----------|--------|-------------|
| Employees | GAS `hr_employees` + Prisma `User.employeeIdGas`, `TradingTelegramUser` | emp_id, name, phone, role, status, joining_date |
| Attendance | Prisma `AttendanceRecord` | employeeId, attendanceDate, checkInAt, checkOutAt, lateMinutes, penaltyAmount |
| Tasks | Prisma `OperationalTask`, `OperationalTaskAssignment` | title, description, deadline, priority, userId |
| Fines | Prisma `EmployeeLedgerEntry` (PENALTY), `TradingVolumeTargetPenalty` | amount, note, status |
| Products/Inventory | GAS `products`, `stock`, `inventory_*` | sku, product, current_stock, reorder_level |
| Orders/Customers | GAS `orders`, `customers`, `update_status` | id, status, customer, phone, sell_price |
| Settings | Prisma `AgentSettings`, `TelegramOpsSetting`, `TradingVolumeTargetSettings` | settingsVersion, officeStartMinutes, gracePeriodMinutes |
| Audit | Prisma `AgentAuditLog` | actionType, resourceId, payload, actor, ipAddress |

## Hermes confirmation message

After Vercel deploy + migration:

> **ALMA full admin endpoints live**

Hermes Stage 2 can wire employee tools, schedulers, and `/staff` command.
