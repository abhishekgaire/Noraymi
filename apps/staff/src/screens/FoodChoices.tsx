import { useState } from "react";
import { useT } from "../i18n.js";

/**
 * A food item's choices on the bar POS (K-05, D100; FoodBar.dc.html · "Wings · choices pop up on
 * tap"): the size, then each group of choices. A required choice must be picked before Add; an
 * optional one ("Make it a meal") can be skipped. A group lets as many choices as its max allows.
 */
export interface ChoiceItem {
  readonly id: string;
  readonly name: string;
  readonly variants: readonly {
    readonly id: string;
    readonly name: string;
    readonly price_cents: number;
    readonly out_tonight: boolean;
  }[];
  readonly groups: readonly {
    readonly id: string;
    readonly name: string;
    readonly required?: boolean;
    readonly min_choices?: number;
    readonly max_choices?: number;
    readonly options: readonly {
      readonly id: string;
      readonly name: string;
      readonly out_tonight: boolean;
      readonly price_delta_cents?: number;
      readonly is_default?: boolean;
    }[];
  }[];
}

const needs = (g: ChoiceItem["groups"][number]) => g.required === true || (g.min_choices ?? 0) > 0;

export function FoodChoices(props: {
  item: ChoiceItem;
  onAdd: (variantId: string, optionIds: readonly string[]) => void;
  onCancel: () => void;
}) {
  const { t, money } = useT();
  const { item } = props;
  const [variant, setVariant] = useState(
    item.variants.length === 1
      ? item.variants[0]!.id
      : (item.variants.find((v) => !v.out_tonight)?.id ?? ""),
  );
  const [picked, setPicked] = useState<readonly string[]>(
    item.groups.flatMap((g) =>
      g.options.filter((o) => o.is_default && !o.out_tonight).map((o) => o.id),
    ),
  );
  const toggle = (g: ChoiceItem["groups"][number], id: string) => {
    const max = g.max_choices ?? 1;
    const inGroup = picked.filter((p) => g.options.some((o) => o.id === p));
    if (picked.includes(id)) return setPicked(picked.filter((p) => p !== id));
    // One choice: picking another replaces it. More: up to the group's max.
    if (max <= 1) return setPicked([...picked.filter((p) => !inGroup.includes(p)), id]);
    if (inGroup.length >= max) return;
    setPicked([...picked, id]);
  };
  const missing = item.groups.find(
    (g) => needs(g) && !g.options.some((o) => picked.includes(o.id)),
  );
  const v = item.variants.find((x) => x.id === variant);
  const price =
    (v?.price_cents ?? 0) +
    item.groups
      .flatMap((g) => g.options)
      .filter((o) => picked.includes(o.id))
      .reduce((s, o) => s + (o.price_delta_cents ?? 0), 0);
  return (
    <div className="sheet food-choices" role="dialog" aria-label={item.name}>
      <h3 data-guest-text>
        {item.name} <span className="kchip">{t("kitchen.chip")}</span>
      </h3>
      {item.variants.length > 1 && (
        <fieldset>
          <legend>{t("kitchen.choices.size")}</legend>
          <div className="choice-row">
            {item.variants.map((x) => (
              <button
                key={x.id}
                type="button"
                className={x.id === variant ? "chip on" : "chip"}
                aria-pressed={x.id === variant}
                disabled={x.out_tonight}
                onClick={() => setVariant(x.id)}
              >
                <span data-guest-text>{x.name}</span>{" "}
                {x.out_tonight ? t("drinks.out") : money(x.price_cents as never)}
              </button>
            ))}
          </div>
        </fieldset>
      )}
      {item.groups.map((g) => (
        <fieldset key={g.id}>
          <legend>
            {needs(g)
              ? (g.max_choices ?? 1) > 1
                ? t("kitchen.choices.pickUpTo", { group: g.name, n: g.max_choices ?? 1 })
                : t("kitchen.choices.pickOne", { group: g.name })
              : t("kitchen.choices.optional", { group: g.name })}
          </legend>
          <div className="choice-row">
            {g.options.map((o) => (
              <button
                key={o.id}
                type="button"
                className={picked.includes(o.id) ? "chip on" : "chip"}
                aria-pressed={picked.includes(o.id)}
                disabled={o.out_tonight}
                onClick={() => toggle(g, o.id)}
              >
                <span data-guest-text>{o.name}</span>
                {o.out_tonight
                  ? ` · ${t("drinks.out")}`
                  : (o.price_delta_cents ?? 0) > 0
                    ? ` +${money(o.price_delta_cents as never)}`
                    : ""}
              </button>
            ))}
          </div>
        </fieldset>
      ))}
      <div className="actions">
        <button type="button" className="secondary" onClick={props.onCancel}>
          {t("kitchen.send.cancel")}
        </button>
        <button
          type="button"
          className="primary"
          disabled={!v || missing !== undefined}
          onClick={() => props.onAdd(variant, picked)}
        >
          {missing
            ? t("kitchen.choices.needed", { group: missing.name.toLowerCase() })
            : t("kitchen.choices.add", { price: money(price as never) })}
        </button>
      </div>
    </div>
  );
}
