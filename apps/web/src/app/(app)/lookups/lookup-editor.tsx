"use client";

import { Download, Plus, Trash2, Upload, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FieldError, Input, Label, Textarea } from "@/components/ui/input";
import { parseCsv, toCsv } from "@/lib/csv";
import { cn } from "@/lib/utils";
import { deleteLookupAction, type LookupPayload, saveLookupAction } from "./actions";

const SHOWN = 500;

export function LookupEditor({
  id,
  initial,
  usage,
}: {
  id: string | null;
  initial: Required<LookupPayload>;
  usage: { id: string; name: string; status: string }[];
}) {
  const router = useRouter();
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [domains, setDomains] = useState(initial.domains);
  const [rows, setRows] = useState(initial.rows.length ? initial.rows : [initial.domains.map(() => "")]);
  const [filter, setFilter] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [importing, setImporting] = useState(false);
  const [csvText, setCsvText] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pending, start] = useTransition();
  const file = useRef<HTMLInputElement>(null);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const all = rows.map((r, i) => ({ r, i }));
    return (q ? all.filter(({ r }) => r.some((c) => c.toLowerCase().includes(q))) : all).slice(0, SHOWN);
  }, [rows, filter]);

  const setCell = (ri: number, ci: number, v: string) =>
    setRows((rs) => rs.map((r, i) => (i === ri ? r.map((c, j) => (j === ci ? v : c)) : r)));
  const addDomain = () => {
    setDomains((d) => [...d, ""]);
    setRows((rs) => rs.map((r) => [...r, ""]));
  };
  const removeDomain = (ci: number) => {
    setDomains((d) => d.filter((_, i) => i !== ci));
    setRows((rs) => rs.map((r) => r.filter((_, i) => i !== ci)));
  };

  const applyCsv = (text: string) => {
    const parsed = parseCsv(text);
    if (parsed.length === 0) {
      setMessage({ ok: false, text: "The CSV is empty." });
      return;
    }
    const [header, ...body] = parsed;
    const width = Math.max(header!.length, 2);
    setDomains(Array.from({ length: width }, (_, i) => (header![i] ?? "").trim()));
    setRows(
      body.length ? body.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? "")) : [Array(width).fill("")],
    );
    setImporting(false);
    setCsvText("");
    setErrors({});
    setMessage({
      ok: true,
      text: `Imported ${body.length} row(s) with domains ${header!.join(", ")}. Save to keep them.`,
    });
  };

  const exportCsv = () => {
    const blob = new Blob([toCsv([domains, ...rows])], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${name || "lookup"}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const save = () =>
    start(async () => {
      const r = await saveLookupAction(id, { name, description, domains, rows });
      setErrors(r.fieldErrors ?? {});
      setMessage(r.ok ? { ok: true, text: r.message ?? "Saved." } : { ok: false, text: r.error ?? "Could not save." });
      if (r.ok && !id && r.id) router.push(`/lookups/${r.id}`);
      else if (r.ok) router.refresh();
    });

  return (
    <div className="flex flex-col gap-4">
      <Card className="grid gap-4 p-5 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="lk-name">Name</Label>
          <Input
            id="lk-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="countries"
            className="font-mono"
          />
          <p className="text-xs text-fg-muted">
            Used in mappings:{" "}
            <code>
              $lookupValue(&quot;{name || "name"}&quot;, &quot;{domains[0] || "from"}&quot;, value, &quot;
              {domains[1] || "to"}&quot;)
            </code>
          </p>
          <FieldError>{errors.name}</FieldError>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="lk-desc">Description</Label>
          <Input
            id="lk-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Shop country codes to ERP codes"
          />
        </div>
      </Card>

      <Card className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            aria-label="Filter rows"
            placeholder="Filter rows…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="h-8 w-48"
          />
          <span className="text-xs text-fg-muted">
            {rows.length} row(s){visible.length < rows.length ? `, showing ${visible.length}` : ""}
          </span>
          <div className="ml-auto flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => setImporting((v) => !v)}>
              <Upload aria-hidden /> Import CSV
            </Button>
            <Button size="sm" variant="secondary" onClick={exportCsv}>
              <Download aria-hidden /> Export CSV
            </Button>
          </div>
        </div>

        {importing && (
          <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
            <p className="text-xs text-fg-muted">
              The first line names the domains. Importing replaces what is in the grid.
            </p>
            <input
              ref={file}
              type="file"
              accept=".csv,text/csv,text/plain"
              aria-label="CSV file"
              className="text-sm"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) applyCsv(await f.text());
              }}
            />
            <Label htmlFor="lk-csv" className="text-xs">
              Or paste CSV
            </Label>
            <Textarea
              id="lk-csv"
              value={csvText}
              onChange={(e) => setCsvText(e.target.value)}
              rows={4}
              className="font-mono text-xs"
              placeholder={"shop,erp\nUS,USA\nIN,IND"}
            />
            <div>
              <Button size="sm" onClick={() => applyCsv(csvText)} disabled={!csvText.trim()}>
                Import pasted CSV
              </Button>
            </div>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full min-w-max border-separate border-spacing-0 text-sm" aria-label="Lookup values">
            <thead>
              <tr>
                {domains.map((d, ci) => (
                  <th key={`d${ci}`} className="min-w-40 border-b border-border p-1 text-left font-normal">
                    <div className="flex items-center gap-1">
                      <Input
                        aria-label={`Domain ${ci + 1}`}
                        value={d}
                        placeholder={ci === 0 ? "e.g. shop (key)" : "e.g. erp"}
                        onChange={(e) => setDomains((ds) => ds.map((x, i) => (i === ci ? e.target.value : x)))}
                        className={cn("h-8 font-medium", errors[`domains.${ci}`] && "border-danger")}
                      />
                      {domains.length > 2 && (
                        <button
                          type="button"
                          aria-label={`Remove domain ${d || ci + 1}`}
                          onClick={() => removeDomain(ci)}
                          className="rounded p-1 text-fg-muted hover:bg-muted"
                        >
                          <X className="size-3.5" />
                        </button>
                      )}
                    </div>
                  </th>
                ))}
                <th className="w-10 border-b border-border p-1">
                  <Button size="sm" variant="ghost" aria-label="Add domain" onClick={addDomain}>
                    <Plus aria-hidden />
                  </Button>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map(({ r, i }) => (
                <tr key={`r${i}`}>
                  {r.map((c, ci) => (
                    <td key={`c${ci}`} className="p-1">
                      <Input
                        aria-label={`Row ${i + 1} ${domains[ci] || `domain ${ci + 1}`}`}
                        value={c}
                        onChange={(e) => setCell(i, ci, e.target.value)}
                        className={cn("h-8", errors[`rows.${i}.${ci}`] && "border-danger")}
                        title={errors[`rows.${i}.${ci}`]}
                      />
                    </td>
                  ))}
                  <td className="p-1">
                    <button
                      type="button"
                      aria-label={`Remove row ${i + 1}`}
                      onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
                      className="rounded p-1.5 text-fg-muted hover:bg-muted"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setFilter("");
              setRows((rs) => [...rs, domains.map(() => "")]);
            }}
          >
            <Plus aria-hidden /> Add row
          </Button>
        </div>
      </Card>

      {Object.keys(errors).length > 0 && (
        <ul className="flex flex-col gap-1 text-sm text-danger" aria-label="Problems">
          {[...new Set(Object.values(errors))].slice(0, 10).map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={save} disabled={pending}>
          {pending ? "Saving…" : id ? "Save" : "Create lookup"}
        </Button>
        {id &&
          (confirmDelete ? (
            <Button
              variant="danger"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const r = await deleteLookupAction(id);
                  if (r?.error) setMessage({ ok: false, text: r.error });
                })
              }
            >
              Confirm delete
            </Button>
          ) : (
            <Button variant="ghost" className="text-danger" onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          ))}
        {message && (
          <p role="status" className={`text-sm ${message.ok ? "text-success" : "text-danger"}`}>
            {message.text}
          </p>
        )}
      </div>

      {usage.length > 0 && (
        <p className="text-sm text-fg-muted">
          Used by:{" "}
          {usage.map((u, n) => (
            <span key={u.id}>
              {n > 0 && ", "}
              <Link href={`/integrations/${u.id}`} className="text-accent hover:underline">
                {u.name}
              </Link>{" "}
              ({u.status})
            </span>
          ))}
        </p>
      )}
    </div>
  );
}
