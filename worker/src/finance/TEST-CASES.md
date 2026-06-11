# Finance Intent Regression Test Cases

These cases verify the system prompt rule: finance intent requires an **explicit money signal**.

## ✅ SHOULD trigger finance tools

| Input | Expected tool | Direction | Note |
|-------|--------------|-----------|------|
| "Karim k 5000 taka disi" | log_ledger_entry | lent | explicit taka + disi |
| "Nahid theke 2000 tk nilam" | log_ledger_entry | borrowed | tk + nilam |
| "Hasib 1000 ferot dilo" | log_ledger_entry | repaid_to_me | ferot = money verb |
| "Nahid ke 500 BDT diye disi jeta dhar nisilam" | log_ledger_entry | repaid_by_me | BDT + diye |
| "lunch e 350 টাকা khoroch hoise" | log_expense | — | টাকা + khoroch |
| "AED 50 diyesi transport e" | log_expense | — | AED + diyesi |
| "dhar ache Karim er kache 3000" | log_ledger_entry | lent | dhar = money verb |
| "pawna 2000 Rahim er kache" | get_ledger_balances | — | pawna = money verb |

## ❌ MUST NOT trigger finance tools

| Input | Why NOT finance |
|-------|----------------|
| "100% kaje lagbe" | percentage, no money signal |
| "1st image ta dao" | ordinal number |
| "5-6 ghonta lagbe" | duration, no money signal |
| "2/3 din er moddhe korbo" | time range |
| "9/10 ta am ache" | quantity without currency |
| "order 3 ta ache" | count without money verb |
| "CTR 40% diye gese" | percentage |
| "5th floor e office" | ordinal |
| "product 2 ta" | count only |

## Test procedure
1. Send each "should trigger" input to agent via Telegram
2. Verify agent calls the correct tool with correct direction
3. Verify confirm card appears before any data is saved
4. Send each "should NOT trigger" input
5. Verify agent responds without calling any finance tool
