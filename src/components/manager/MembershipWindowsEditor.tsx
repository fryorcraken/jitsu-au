import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { listAllSemesters, saveMembershipSemester } from "@/lib/membership.functions";
import type { ClubSemesterRow } from "@/lib/membership-types";

type NewWindowForm = {
  year: string;
  half: "1" | "2";
  name: string;
  starts_on: string;
  ends_on: string;
};

const emptyNewWindow = (): NewWindowForm => ({
  year: String(new Date().getFullYear()),
  half: "1",
  name: "",
  starts_on: "",
  ends_on: "",
});

/**
 * The membership-window editor, embedded in the plans page. A "window" is the
 * span a membership runs for (e.g. 20 Jul to 16 Dec), stored on `club_semesters`.
 * Editing dates changes only what NEW memberships get: existing memberships
 * keep the dates they were activated with.
 */
export function MembershipWindowsEditor() {
  const fetchAll = useServerFn(listAllSemesters);
  const save = useServerFn(saveMembershipSemester);

  const [windows, setWindows] = useState<ClubSemesterRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingCode, setSavingCode] = useState<string | null>(null);
  const [addingNew, setAddingNew] = useState(false);
  const [newWindow, setNewWindow] = useState<NewWindowForm>(emptyNewWindow);

  const reload = useMemo(
    () => () => fetchAll().then((data) => setWindows(data as ClubSemesterRow[])),
    [fetchAll],
  );

  useEffect(() => {
    reload()
      .catch((e) => toast.error(e instanceof Error ? e.message : "Failed to load windows"))
      .finally(() => setLoading(false));
  }, [reload]);

  function patch(id: string, p: Partial<ClubSemesterRow>) {
    setWindows((prev) => prev.map((s) => (s.id === id ? { ...s, ...p } : s)));
  }

  async function onSaveExisting(w: ClubSemesterRow) {
    setSavingCode(w.code);
    try {
      await save({
        data: {
          year: w.year,
          half: w.half as 1 | 2,
          name: w.name,
          starts_on: w.starts_on,
          ends_on: w.ends_on,
          is_active: w.is_active,
        },
      });
      toast.success(`Saved ${w.name}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSavingCode(null);
    }
  }

  async function onCreate() {
    const year = Number(newWindow.year);
    const half = Number(newWindow.half) as 1 | 2;
    if (!Number.isInteger(year) || !newWindow.name.trim()) {
      toast.error("Give the window a year and a name.");
      return;
    }
    if (!newWindow.starts_on || !newWindow.ends_on) {
      toast.error("Set both a start and an end date.");
      return;
    }
    setAddingNew(true);
    try {
      await save({
        data: {
          year,
          half,
          name: newWindow.name.trim(),
          starts_on: newWindow.starts_on,
          ends_on: newWindow.ends_on,
          is_active: true,
        },
      });
      toast.success("Window added");
      setNewWindow(emptyNewWindow());
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not add the window");
    } finally {
      setAddingNew(false);
    }
  }

  if (loading) return <p className="text-sm text-muted-foreground">Loading windows...</p>;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Windows are the date spans a membership runs for, such as 20 Jul to 16 Dec. A member picks
        the current window or the next one when they join, and their membership runs exactly those
        dates, full price regardless of when in it they join. Editing dates changes only what a NEW
        membership gets.
      </p>

      {windows.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No windows yet. Add one below before members try to buy a membership.
        </p>
      )}
      {windows.map((w) => (
        <Card key={w.id}>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-3">
              <CardTitle className="text-lg">{w.name}</CardTitle>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={w.is_active}
                  onCheckedChange={(v) => patch(w.id, { is_active: v === true })}
                />
                Active
              </label>
            </div>
            <p className="text-xs text-muted-foreground">
              <code>{w.code}</code>
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label className="text-xs">Name</Label>
              <Input
                value={w.name}
                onChange={(e) => patch(w.id, { name: e.target.value })}
                maxLength={120}
                className="mt-1"
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label className="text-xs">Starts</Label>
                <Input
                  type="date"
                  value={w.starts_on}
                  onChange={(e) => patch(w.id, { starts_on: e.target.value })}
                  className="mt-1"
                />
              </div>
              <div>
                <Label className="text-xs">Ends</Label>
                <Input
                  type="date"
                  value={w.ends_on}
                  onChange={(e) => patch(w.id, { ends_on: e.target.value })}
                  className="mt-1"
                />
              </div>
            </div>
            <Button size="sm" disabled={savingCode === w.code} onClick={() => onSaveExisting(w)}>
              {savingCode === w.code ? "Saving..." : "Save"}
            </Button>
          </CardContent>
        </Card>
      ))}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg">Add a window</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label className="text-xs">Year</Label>
              <Input
                inputMode="numeric"
                value={newWindow.year}
                onChange={(e) => setNewWindow((s) => ({ ...s, year: e.target.value }))}
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="new-window-half" className="text-xs">
                Half
              </Label>
              <select
                id="new-window-half"
                value={newWindow.half}
                onChange={(e) => setNewWindow((s) => ({ ...s, half: e.target.value as "1" | "2" }))}
                className="mt-1 flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
              >
                <option value="1">Semester 1</option>
                <option value="2">Semester 2</option>
              </select>
            </div>
          </div>
          <div>
            <Label className="text-xs">Name</Label>
            <Input
              placeholder="Semester 1 2027"
              value={newWindow.name}
              onChange={(e) => setNewWindow((s) => ({ ...s, name: e.target.value }))}
              maxLength={120}
              className="mt-1"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label className="text-xs">Starts</Label>
              <Input
                type="date"
                value={newWindow.starts_on}
                onChange={(e) => setNewWindow((s) => ({ ...s, starts_on: e.target.value }))}
                className="mt-1"
              />
            </div>
            <div>
              <Label className="text-xs">Ends</Label>
              <Input
                type="date"
                value={newWindow.ends_on}
                onChange={(e) => setNewWindow((s) => ({ ...s, ends_on: e.target.value }))}
                className="mt-1"
              />
            </div>
          </div>
          <Button size="sm" disabled={addingNew} onClick={onCreate}>
            {addingNew ? "Adding..." : "Add window"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
