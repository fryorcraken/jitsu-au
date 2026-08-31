import { useEffect, useMemo, useState } from "react";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Loading } from "@/components/site/Loading";
import {
  BELT_SIZE_HINT,
  BeltSizeSelect,
  GI_SIZE_HINT,
  GiSizeSelect,
} from "@/components/site/KitSizeSelect";
import type { BeltSize, GiSize } from "@/lib/kit-sizes";
import { isBeltSize, isGiSize } from "@/lib/kit-sizes";
import { CardActions } from "./CardActions";
import { useDetailsSave, type DetailsCardProps } from "./DetailsCard";

/**
 * Gi and belt sizes. Kept apart from the contact card because it is the one
 * group here a manager reads in bulk (ordering kit), and because it is the only
 * one a waiver never overwrites.
 */
export function KitSizingCard({ userId, profile, loading, onSaved }: DetailsCardProps) {
  const { busy, save } = useDetailsSave({ userId, profile, onSaved });
  const [giSize, setGiSize] = useState<GiSize | "">("");
  const [beltSize, setBeltSize] = useState<BeltSize | "">("");

  // See AboutYouCard: keyed on this card's own fields, never on `profile`.
  const stored = useMemo(() => {
    const gi = profile?.gi_size ?? "";
    const belt = profile?.belt_size ?? "";
    return {
      giSize: (isGiSize(gi) ? gi : "") as GiSize | "",
      beltSize: (isBeltSize(belt) ? belt : "") as BeltSize | "",
    };
  }, [profile?.gi_size, profile?.belt_size]);

  const revert = useMemo(
    () => () => {
      setGiSize(stored.giSize);
      setBeltSize(stored.beltSize);
    },
    [stored],
  );

  useEffect(revert, [revert]);

  const dirty = giSize !== stored.giSize || beltSize !== stored.beltSize;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    await save(
      { gi_size: giSize || null, belt_size: beltSize || null },
      "Sizes saved",
      "Could not save your sizes",
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Kit sizing</CardTitle>
        <CardDescription>
          So we can order the right gi and belt for you, and hand you the right loan gear. Both are
          optional.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Loading />
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <Label htmlFor="gi-size">Gi size</Label>
              <GiSizeSelect
                id="gi-size"
                value={giSize}
                onChange={setGiSize}
                disabled={busy}
                className="mt-1.5"
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                The number in brackets is the wearer's height that gi size is cut for.{" "}
                {GI_SIZE_HINT}
              </p>
            </div>
            <div>
              <Label htmlFor="belt-size">Belt size</Label>
              <BeltSizeSelect
                id="belt-size"
                value={beltSize}
                onChange={setBeltSize}
                disabled={busy}
                className="mt-1.5"
              />
              <p className="mt-1.5 text-xs text-muted-foreground">{BELT_SIZE_HINT}</p>
            </div>
            <CardActions dirty={dirty} busy={busy} onRevert={revert} />
          </form>
        )}
      </CardContent>
    </Card>
  );
}
