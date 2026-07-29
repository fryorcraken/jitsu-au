import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCents, parseMoneyToCents, type BankTxnRow } from "@/lib/validation";
import {
  importBankStatement,
  listBankTransactions,
  listMemberships,
  matchTransaction,
} from "@/lib/membership.functions";
import { useAuth, useRoles } from "@/hooks/useAuth";

export const Route = createFileRoute("/_authenticated/manager/reconciliation")({
  head: () => ({
    meta: [{ title: "Reconciliation | UTS Jitsu" }, { name: "robots", content: "noindex" }],
  }),
  component: ReconciliationPage,
});

type Membership = Awaited<ReturnType<typeof listMemberships>>[number];
type BankTxn = Awaited<ReturnType<typeof listBankTransactions>>[number];

/** Minimal RFC-4180-ish CSV parser (handles quoted fields and commas). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((v) => v.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    if (row.some((v) => v.trim() !== "")) rows.push(row);
  }
  return rows;
}

/** Normalize a date cell to YYYY-MM-DD (accepts ISO or AU dd/mm/yyyy). */
function normalizeDate(value: string): string {
  const t = value.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/.exec(t);
  if (m) {
    const [, d, mo, y] = m;
    const year = y.length === 2 ? `20${y}` : y;
    return `${year}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return "";
}

/** Map parsed CSV into the bank-row shape, keeping only positive credits. */
function toBankRows(rows: string[][]): BankTxnRow[] {
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const find = (...keys: string[]) => header.findIndex((h) => keys.some((k) => h.includes(k)));
  const dateIdx = find("date");
  const amountIdx = find("amount", "credit", "deposit");
  const descIdx = find("description", "narrative", "details", "reference", "memo");
  const refIdx = find("reference");

  const out: BankTxnRow[] = [];
  for (const r of rows.slice(1)) {
    const cents = amountIdx >= 0 ? parseMoneyToCents(r[amountIdx] ?? "") : null;
    if (cents == null || cents <= 0) continue; // only incoming credits can pay a membership
    out.push({
      posted_at: dateIdx >= 0 ? normalizeDate(r[dateIdx] ?? "") : "",
      amount_cents: cents,
      description: descIdx >= 0 ? (r[descIdx] ?? "").trim() : "",
      reference: refIdx >= 0 ? (r[refIdx] ?? "").trim() : "",
    });
  }
  return out;
}

function ReconciliationPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { isManager, loading: rolesLoading } = useRoles(user?.id);
  const runImport = useServerFn(importBankStatement);
  const fetchTxns = useServerFn(listBankTransactions);
  const fetchMemberships = useServerFn(listMemberships);
  const runMatch = useServerFn(matchTransaction);
  const fileRef = useRef<HTMLInputElement>(null);

  const [txns, setTxns] = useState<BankTxn[]>([]);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const pending = useMemo(() => memberships.filter((m) => m.status === "pending"), [memberships]);

  useEffect(() => {
    if (!rolesLoading && user && !isManager) navigate({ to: "/account" });
  }, [rolesLoading, isManager, user, navigate]);

  const reload = useMemo(
    () => () =>
      Promise.all([fetchTxns(), fetchMemberships()]).then(([t, m]) => {
        setTxns(t as BankTxn[]);
        setMemberships(m as Membership[]);
      }),
    [fetchTxns, fetchMemberships],
  );

  useEffect(() => {
    if (!isManager) return;
    reload()
      .catch((e) => toast.error(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, [isManager, reload]);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const text = await file.text();
      const rows = toBankRows(parseCsv(text));
      if (rows.length === 0) {
        toast.error("No credit transactions found in that file.");
        return;
      }
      const res = await runImport({ data: { rows } });
      await reload();
      // A null count means the import and its matching worked but the tally
      // afterwards did not. The list below has just reloaded, so say the count
      // is unavailable rather than quoting a number nobody counted.
      const unmatchedPart =
        res.unmatched === null ? "unmatched count unavailable" : `${res.unmatched} unmatched`;
      toast.success(
        `Imported ${res.imported} rows · ${res.matched} auto-matched · ${unmatchedPart}`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Import failed");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function manualMatch(txnId: string, membershipId: string) {
    if (!membershipId) return;
    setBusy(true);
    try {
      await runMatch({ data: { transaction_id: txnId, membership_id: membershipId } });
      await reload();
      toast.success("Matched and activated");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Match failed");
    } finally {
      setBusy(false);
    }
  }

  const unmatched = txns.filter((t) => t.status === "unmatched");

  return (
    <>
      <section className="mx-auto max-w-5xl space-y-6 px-4 py-10">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-3xl font-black">Bank reconciliation</h1>
            <p className="text-sm text-muted-foreground">
              Import a bank statement (CSV). Transfers are auto-matched to pending memberships by
              payment reference and amount.
            </p>
          </div>
          <Button asChild variant="outline">
            <Link to="/manager/memberships">Back to memberships</Link>
          </Button>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Import a statement</CardTitle>
            <CardDescription>
              Export your account transactions as CSV. We read the date, amount and description
              columns and keep incoming credits only.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              onChange={onFile}
              disabled={busy}
              className="block text-sm file:mr-4 file:rounded-md file:border file:bg-muted file:px-3 file:py-1.5 file:text-sm"
            />
          </CardContent>
        </Card>

        {loading ? (
          <p>Loading...</p>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Unmatched transactions</CardTitle>
              <CardDescription>
                {unmatched.length === 0
                  ? "Everything imported has been matched."
                  : "Link any leftover transfers to a pending membership by hand."}
              </CardDescription>
            </CardHeader>
            {unmatched.length > 0 && (
              <CardContent>
                <div className="overflow-x-auto rounded-lg border">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50 text-left">
                      <tr>
                        <th className="px-3 py-2">Date</th>
                        <th className="px-3 py-2">Amount</th>
                        <th className="px-3 py-2">Description</th>
                        <th className="px-3 py-2">Match to pending</th>
                      </tr>
                    </thead>
                    <tbody>
                      {unmatched.map((t) => (
                        <tr key={t.id} className="border-t">
                          <td className="px-3 py-2 whitespace-nowrap">{t.posted_at ?? "—"}</td>
                          <td className="px-3 py-2">{formatCents(t.amount_cents)}</td>
                          <td className="px-3 py-2 max-w-xs truncate" title={t.description}>
                            {t.description || "—"}
                          </td>
                          <td className="px-3 py-2">
                            <select
                              disabled={busy || pending.length === 0}
                              defaultValue=""
                              onChange={(e) => manualMatch(t.id, e.target.value)}
                              className="rounded-md border bg-background px-2 py-1 text-sm"
                            >
                              <option value="">
                                {pending.length === 0 ? "No pending memberships" : "Select…"}
                              </option>
                              {pending.map((m) => (
                                <option key={m.id} value={m.id}>
                                  {m.payment_reference} ·{" "}
                                  {m.member_name ?? m.member_email ?? "member"} ·{" "}
                                  {formatCents(m.price_cents)}
                                </option>
                              ))}
                            </select>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            )}
          </Card>
        )}
      </section>
    </>
  );
}
