import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
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
import { useAuth, useRoles } from "@/hooks/useAuth";

export const Route = createFileRoute("/_authenticated/manager/semesters")({
  head: () => ({
    meta: [{ title: "Semesters | UTS Jitsu" }, { name: "robots", content: "noindex" }],
  }),
  component: SemestersPage,
});

type NewSemesterForm = {
  year: string;
  half: "1" | "2";
  name: string;
  starts_on: string;
  ends_on: string;
};

const emptyNewSemester = (): NewSemesterForm => ({
  year: String(new Date().getFullYear()),
  half: "1",
  name: "",
  starts_on: "",
  ends_on: "",
});

function SemestersPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { isManager, loading: rolesLoading } = useRoles(user?.id);
  const fetchAll = useServerFn(listAllSemesters);
  const save = useServerFn(saveMembershipSemester);

  const [semesters, setSemesters] = useState<ClubSemesterRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingCode, setSavingCode] = useState<string | null>(null);
  const [addingNew, setAddingNew] = useState(false);
  const [newSemester, setNewSemester] = useState<NewSemesterForm>(emptyNewSemester);

  useEffect(() => {
    if (!rolesLoading && user && !isManager) navigate({ to: "/account" });
  }, [rolesLoading, isManager, user, navigate]);

  const reload = useMemo(
    () => () => fetchAll().then((data) => setSemesters(data as ClubSemesterRow[])),
    [fetchAll],
  );

  useEffect(() => {
    if (!isManager) return;
    reload()
      .catch((e) => toast.error(e instanceof Error ? e.message : "Failed to load semesters"))
      .finally(() => setLoading(false));
  }, [isManager, reload]);

  function patch(id: string, p: Partial<ClubSemesterRow>) {
    setSemesters((prev) => prev.map((s) => (s.id === id ? { ...s, ...p } : s)));
  }

  async function onSaveExisting(semester: ClubSemesterRow) {
    setSavingCode(semester.code);
    try {
      await save({
        data: {
          year: semester.year,
          half: semester.half as 1 | 2,
          name: semester.name,
          starts_on: semester.starts_on,
          ends_on: semester.ends_on,
          is_active: semester.is_active,
        },
      });
      toast.success(`Saved ${semester.name}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSavingCode(null);
    }
  }

  async function onCreate() {
    const year = Number(newSemester.year);
    const half = Number(newSemester.half) as 1 | 2;
    if (!Number.isInteger(year) || !newSemester.name.trim()) {
      toast.error("Give the semester a year and a name.");
      return;
    }
    if (!newSemester.starts_on || !newSemester.ends_on) {
      toast.error("Set both a start and an end date.");
      return;
    }
    setAddingNew(true);
    try {
      await save({
        data: {
          year,
          half,
          name: newSemester.name.trim(),
          starts_on: newSemester.starts_on,
          ends_on: newSemester.ends_on,
          is_active: true,
        },
      });
      toast.success("Semester added");
      setNewSemester(emptyNewSemester());
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not add the semester");
    } finally {
      setAddingNew(false);
    }
  }

  if (loading) {
    return (
      <>
        <div className="p-8">Loading...</div>
      </>
    );
  }

  return (
    <>
      <section className="mx-auto max-w-3xl space-y-6 px-4 py-10">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-3xl font-black">Semesters</h1>
            <p className="text-sm text-muted-foreground">
              The club's own fixed training dates for each half-year. A member picks one of these
              when they buy a semester membership, and their membership runs exactly the dates set
              here at that moment, full price regardless of when in it they join. Editing an
              existing semester's dates only changes what a NEW membership gets: anyone who has
              already joined keeps the dates they were given.
            </p>
          </div>
          <Button asChild variant="outline">
            <Link to="/manager/membership-plans">Back to plans</Link>
          </Button>
        </div>

        <div className="space-y-4">
          {semesters.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No semesters yet. Add the club's dates below before members try to buy a semester
              membership.
            </p>
          )}
          {semesters.map((semester) => (
            <Card key={semester.id}>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between gap-3">
                  <CardTitle className="text-lg">{semester.name}</CardTitle>
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={semester.is_active}
                      onCheckedChange={(v) => patch(semester.id, { is_active: v === true })}
                    />
                    Active
                  </label>
                </div>
                <p className="text-xs text-muted-foreground">
                  <code>{semester.code}</code>
                </p>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label className="text-xs">Name</Label>
                  <Input
                    value={semester.name}
                    onChange={(e) => patch(semester.id, { name: e.target.value })}
                    maxLength={120}
                    className="mt-1"
                  />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label className="text-xs">Starts</Label>
                    <Input
                      type="date"
                      value={semester.starts_on}
                      onChange={(e) => patch(semester.id, { starts_on: e.target.value })}
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Ends</Label>
                    <Input
                      type="date"
                      value={semester.ends_on}
                      onChange={(e) => patch(semester.id, { ends_on: e.target.value })}
                      className="mt-1"
                    />
                  </div>
                </div>
                <Button
                  size="sm"
                  disabled={savingCode === semester.code}
                  onClick={() => onSaveExisting(semester)}
                >
                  {savingCode === semester.code ? "Saving..." : "Save"}
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg">Add a semester</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label className="text-xs">Year</Label>
                <Input
                  inputMode="numeric"
                  value={newSemester.year}
                  onChange={(e) => setNewSemester((s) => ({ ...s, year: e.target.value }))}
                  className="mt-1"
                />
              </div>
              <div>
                <Label htmlFor="new-semester-half" className="text-xs">
                  Half
                </Label>
                <select
                  id="new-semester-half"
                  value={newSemester.half}
                  onChange={(e) =>
                    setNewSemester((s) => ({ ...s, half: e.target.value as "1" | "2" }))
                  }
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
                value={newSemester.name}
                onChange={(e) => setNewSemester((s) => ({ ...s, name: e.target.value }))}
                maxLength={120}
                className="mt-1"
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label className="text-xs">Starts</Label>
                <Input
                  type="date"
                  value={newSemester.starts_on}
                  onChange={(e) => setNewSemester((s) => ({ ...s, starts_on: e.target.value }))}
                  className="mt-1"
                />
              </div>
              <div>
                <Label className="text-xs">Ends</Label>
                <Input
                  type="date"
                  value={newSemester.ends_on}
                  onChange={(e) => setNewSemester((s) => ({ ...s, ends_on: e.target.value }))}
                  className="mt-1"
                />
              </div>
            </div>
            <Button size="sm" disabled={addingNew} onClick={onCreate}>
              {addingNew ? "Adding..." : "Add semester"}
            </Button>
          </CardContent>
        </Card>
      </section>
    </>
  );
}
