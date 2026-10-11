import { useState } from "react";
import { useT } from "../i18n.js";
import {
  choiceLabel,
  defaultPicks,
  missingGroup,
  needsPick,
  openGroups,
  prunePicks,
  togglePick,
  unitWithChoices,
  type ChoiceGroupLike,
} from "./choices.js";

/**
 * A food item's choices on the bar POS (K-05, D100; FoodBar.dc.html · "Wings · choices pop up on
 * tap"): the size, then each group of choices. A required choice must be picked before Add; an
 * optional one ("Make it a meal") can be skipped. A group lets as many choices as its max allows.
 * K-12: a group shows only for its sizes and once the choice that opens it is picked ("Make it a
 * meal" opens the side and the drink); included picks and the extra price show under its name;
 * the price is the order's, components included.
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
  readonly groups: readonly ChoiceGroupLike[];
}

export function FoodChoices(props: {
  item: ChoiceItem;
  /** A drink with choices (K-12: sizes, many picks) opens the same sheet, without the food chip. */
  drink?: boolean;
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
  const [picked, setPicked] = useState<readonly string[]>(defaultPicks(item.groups, variant));
  // One choice: picking another replaces it. More: up to the group's max. A closed group's picks drop.
  const toggle = (g: ChoiceGroupLike, id: string) =>
    setPicked(togglePick(item.groups, variant, picked, g, id));
  const pickSize = (id: string) => {
    setVariant(id);
    setPicked(prunePicks(item.groups, id, picked));
  };
  const missing = missingGroup(item.groups, variant, picked);
  const v = item.variants.find((x) => x.id === variant);
  const price = v ? unitWithChoices(item.groups, v, picked) : 0;
  return (
    <div className="sheet food-choices" role="dialog" aria-label={item.name}>
      <h3 data-guest-text>
        {item.name} {!props.drink && <span className="kchip">{t("kitchen.chip")}</span>}
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
                onClick={() => pickSize(x.id)}
              >
                <span data-guest-text>{x.name}</span>{" "}
                {x.out_tonight ? t("drinks.out") : money(x.price_cents as never)}
              </button>
            ))}
          </div>
        </fieldset>
      )}
      {openGroups(item.groups, variant, picked).map((g) => (
        <fieldset key={g.id}>
          <legend>
            {needsPick(g)
              ? (g.max_choices ?? 1) > 1
                ? t("kitchen.choices.pickUpTo", { group: g.name, n: g.max_choices ?? 1 })
                : t("kitchen.choices.pickOne", { group: g.name })
              : t("kitchen.choices.optional", { group: g.name })}
          </legend>
          {g.included_choices != null && (
            <p className="hint">
              {(g.extra_choice_cents ?? 0) > 0
                ? t("kitchen.choices.included", {
                    n: g.included_choices,
                    price: money((g.extra_choice_cents ?? 0) as never),
                  })
                : t("kitchen.choices.includedOnly", { n: g.included_choices })}
            </p>
          )}
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
                <span data-guest-text>{choiceLabel(o)}</span>
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
