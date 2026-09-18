/** @jsxImportSource preact */
/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { WebCommandBadge } from "../../annotations";
import type { WebRunsMembership, WebRunsOrder } from "../../commandTree";
import { renderCliLine } from "../../argv";
import type { WebField } from "../../commandFields";
import { searchWidget } from "../api";
import {
  appendValue,
  splitFields,
  stableScopeKey,
  toInvocation,
  type FormValues,
  type WidgetScope,
} from "../formModel";
import { CommandNote } from "./CommandTree";

type FieldWithWidget = WebField & { widget?: string };

function SearchWidget({
  field,
  value,
  scope,
  onChange,
}: {
  field: FieldWithWidget;
  value: string;
  scope: WidgetScope | undefined;
  onChange: (next: string) => void;
}): JSX.Element {
  const [items, setItems] = useState<readonly { value: string; label: string; detail?: string }[]>(
    []
  );
  const [open, setOpen] = useState(false);
  const scopeKey = scope ? stableScopeKey(scope) : "";

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // A list field searches on the fragment being typed, not on the list: the
    // whole value of a picked-plus-typing `--models` matches no model at all.
    const needle = field.multiple ? (value.split(",").pop() ?? "").trim() : value;
    void searchWidget(field.format ?? "", needle, scope)
      .then((result) => {
        if (!cancelled) setItems(result.items);
      })
      .catch(() => setItems([]));
    return () => {
      cancelled = true;
    };
    // `scope` is a fresh object on every render of the form, so depending on it
    // directly re-fires this search whenever ANY field changes — a keystroke in
    // one box re-queries every open picker on the page. The effect depends on a
    // serialization of what the search actually reads instead, so it re-runs
    // when the scope's CONTENT changes and not when its identity does.
  }, [open, value, field.format, field.multiple, scopeKey, scope]);

  return (
    <div>
      <div className="wlookup">
        <input
          type="text"
          value={value}
          placeholder={field.placeholder}
          onInput={(event) => onChange((event.target as HTMLInputElement).value)}
          onFocus={() => setOpen(true)}
        />
        <button className="btn" type="button" onClick={() => setOpen(!open)}>
          {open ? "Hide" : "Browse"}
        </button>
      </div>
      {open && items.length > 0 ? (
        <div className="card" style="margin-top:6px;max-height:220px;overflow:auto">
          {items.map((item) => (
            <button
              key={item.value}
              className="cmd"
              onClick={() => {
                onChange(field.multiple ? appendValue(value, item.value) : item.value);
                if (!field.multiple) setOpen(false);
              }}
            >
              <span className="cmd-n">{item.label}</span>
              <span className="cmd-d">{item.detail ?? ""}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A one-line field that can become a text box.
 *
 * Some string options carry prose — a reply to a reader, a commit message, a
 * reason kept with a grant — and the form has no way to know which: the type is
 * `string` either way, and `WebField` has no multiline variant to declare. The
 * existing heuristics (`object`, `array`, a description over 90 characters)
 * catch the fields whose SHAPE says so and miss every field whose CONTENT does.
 *
 * So the choice is given to whoever is typing, rather than guessed at. The
 * button is the whole affordance: no annotation to add, no schema to change,
 * and every string field in every downstream CLI gets it for free.
 *
 * A value that already contains a newline stays expanded and cannot be
 * collapsed — a single-line input would render only the first line while
 * quietly holding the rest, which reads as data loss.
 */
function ExpandableText({
  field,
  value,
  onChange,
}: {
  field: FieldWithWidget;
  value: string;
  onChange: (next: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const multiline = value.includes("\n");
  const expanded = open || multiline;

  return (
    <div className={`fexp${expanded ? " open" : ""}`}>
      {expanded ? (
        <textarea
          value={value}
          placeholder={field.placeholder}
          // Focused on expand so the click lands the caret in the box it just
          // opened, rather than leaving it in an input that is no longer there.
          ref={(node) => {
            if (open && node && document.activeElement !== node) node.focus();
          }}
          onInput={(event) => onChange((event.target as HTMLTextAreaElement).value)}
        />
      ) : (
        <input
          type="text"
          value={value}
          placeholder={field.placeholder}
          onInput={(event) => onChange((event.target as HTMLInputElement).value)}
        />
      )}
      <button
        type="button"
        className="fexpb"
        // Disabled rather than hidden: a control that vanishes once the value
        // wraps looks like a bug, and the title says why it will not collapse.
        disabled={multiline}
        title={
          multiline
            ? "This value has line breaks, so it stays a text box"
            : expanded
              ? "Collapse to one line"
              : "Expand to a text box"
        }
        aria-label={expanded ? `Collapse ${field.key}` : `Expand ${field.key}`}
        aria-expanded={expanded}
        onClick={() => setOpen(!open)}
      >
        {expanded ? "\u2921" : "\u2922"}
      </button>
    </div>
  );
}

function Control({
  field,
  value,
  scope,
  onChange,
}: {
  field: FieldWithWidget;
  value: string | boolean | undefined;
  scope: WidgetScope | undefined;
  onChange: (next: string | boolean) => void;
}): JSX.Element {
  if (field.type === "boolean") {
    return (
      <label className="swi">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(event) => onChange((event.target as HTMLInputElement).checked)}
        />
        <span>{value === true ? "on" : "off"}</span>
      </label>
    );
  }
  if (field.choices) {
    return (
      <select
        value={String(value ?? "")}
        onChange={(e) => onChange((e.target as HTMLSelectElement).value)}
      >
        <option value="">—</option>
        {field.choices.map((choice) => (
          <option key={choice} value={choice}>
            {choice}
          </option>
        ))}
      </select>
    );
  }
  if (field.widget === "search") {
    return (
      <SearchWidget field={field} value={String(value ?? "")} scope={scope} onChange={onChange} />
    );
  }
  if (field.type === "object" || field.type === "array" || field.description.length > 90) {
    return (
      <textarea
        value={String(value ?? "")}
        placeholder={field.placeholder}
        onInput={(event) => onChange((event.target as HTMLTextAreaElement).value)}
      />
    );
  }
  // Numbers keep the plain stepper: there is no long form of a number, and a
  // text box for one would only invite a value the parser rejects.
  if (field.type === "number" || field.type === "integer") {
    return (
      <input
        type="number"
        value={String(value ?? "")}
        placeholder={field.placeholder}
        onInput={(event) => onChange((event.target as HTMLInputElement).value)}
      />
    );
  }
  return <ExpandableText field={field} value={String(value ?? "")} onChange={onChange} />;
}

function FieldRows({
  fields,
  values,
  scope,
  onChange,
}: {
  fields: readonly FieldWithWidget[];
  values: FormValues;
  scope: WidgetScope | undefined;
  onChange: (key: string, value: string | boolean) => void;
}): JSX.Element {
  return (
    <div className="card">
      {fields.map((field) => (
        <div className={`field${field.required ? " req" : ""}`} key={field.key}>
          <div className="fl">
            <b>{field.key}</b>
            {field.description ? <span>{field.description}</span> : null}
            {field.source === "config" ? <span className="badge">config</span> : null}
          </div>
          <div className="fc">
            <Control
              field={field}
              value={values[field.key]}
              scope={scope}
              onChange={(next) => onChange(field.key, next)}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * What an `all` actually runs, written out where the Run button is.
 *
 * The rail's marker is a count; this is the list behind it, because "runs 4 of
 * 5" is only useful once you can see WHICH four and in what order. The skipped
 * siblings are named in the same block rather than left implicit — an operator
 * who runs `all` nightly needs to know what it never covers, and absence is
 * not something a form can show.
 */
function RunPlan({
  path,
  order,
  membership,
}: {
  path: readonly string[];
  order: WebRunsOrder | undefined;
  membership: WebRunsMembership | undefined;
}): JSX.Element | null {
  // The group these commands sit in, named the way the operator would type it.
  const group = path.slice(0, -1).join(" ");
  if (order) {
    const of = order.members.length + order.skipped.length;
    return (
      <div className="plan">
        <h3>
          Runs {order.members.length} of the {of} commands
          {group ? (
            <>
              {" "}
              under <code>{group}</code>
            </>
          ) : (
            " beside it"
          )}
          , in order
        </h3>
        <ol>
          {order.members.map((member) => (
            <li key={member.name}>
              <code>{member.name}</code>
              {member.when ? <span className="when">{member.when}</span> : null}
            </li>
          ))}
        </ol>
        {order.skipped.length > 0 ? (
          <p className="skipped">
            Not run by this command:{" "}
            {order.skipped.map((name, index) => (
              <span key={name}>
                {index > 0 ? ", " : ""}
                <code>{name}</code>
              </span>
            ))}
          </p>
        ) : null}
      </div>
    );
  }
  if (membership) {
    return (
      <div className="plan">
        <h3>
          Runs as step {membership.step} of {membership.of} of{" "}
          <code>{[group, membership.command].filter(Boolean).join(" ")}</code>
        </h3>
        {membership.when ? <p className="skipped">There, it runs {membership.when}.</p> : null}
      </div>
    );
  }
  return null;
}

export function OptionsForm({
  binaryName,
  path,
  description,
  fields,
  values,
  errors,
  badges,
  note,
  runsInOrder,
  runsIn,
  onChange,
  onRun,
  canRun = true,
}: {
  binaryName: string;
  path: readonly string[];
  /**
   * The command's one-line help. It reads here rather than in the breadcrumb:
   * the crumb clips it to whatever the topbar has left over, and this is the
   * pane where someone is deciding what the command does before running it.
   */
  description?: string;
  fields: readonly FieldWithWidget[];
  values: FormValues;
  errors: readonly string[];
  badges?: readonly WebCommandBadge[];
  note?: string;
  /** Set when this command runs its siblings in order — an `all`. */
  runsInOrder?: WebRunsOrder;
  /** Set when a sibling `all` runs this command. */
  runsIn?: WebRunsMembership;
  onChange: (key: string, value: string | boolean) => void;
  onRun: (dryRun: boolean) => void;
  /** False while the CLI is not answering its heartbeat; running would just fail. */
  canRun?: boolean;
}): JSX.Element {
  const { args, inputs, advanced } = splitFields(fields);
  const line = renderCliLine(binaryName, toInvocation(fields, values, path));
  // The picker for one field is answered from the whole form, so the scope is
  // rebuilt from the values on every render rather than captured per field.
  const scope: WidgetScope = {
    path,
    args: args.map((field) => String(values[field.key] ?? "")),
    values,
  };
  // Offering a flag the command does not declare produces a rejected run, so
  // the button exists only where `--dry-run` is real.
  const hasDryRun = fields.some((field) => field.key === "dry-run" && field.source === "option");

  return (
    <div className="wrap">
      {description ? <p className="lede">{description}</p> : null}
      <CommandNote badges={badges} note={note} />
      <RunPlan path={path} order={runsInOrder} membership={runsIn} />
      {args.length > 0 ? (
        <>
          <h2 className="sec">Arguments</h2>
          <FieldRows fields={args} values={values} scope={scope} onChange={onChange} />
        </>
      ) : null}
      {inputs.length > 0 ? (
        <>
          <h2 className="sec">Inputs</h2>
          <FieldRows fields={inputs} values={values} scope={scope} onChange={onChange} />
        </>
      ) : null}
      {advanced.length > 0 ? (
        <details className="adv">
          <summary>{advanced.length} more options</summary>
          <FieldRows fields={advanced} values={values} scope={scope} onChange={onChange} />
        </details>
      ) : null}

      <div className="cmdbar">
        <code>
          <span className="pr">$ </span>
          {line}
        </code>
        <div className="acts">
          <button className="ghost" onClick={() => void navigator.clipboard?.writeText(line)}>
            Copy
          </button>
          {hasDryRun ? (
            <button className="ghost" onClick={() => onRun(true)} disabled={!canRun}>
              Dry run
            </button>
          ) : null}
          <button
            className="btn primary"
            onClick={() => onRun(false)}
            disabled={errors.length > 0 || !canRun}
            title={canRun ? undefined : "the CLI is not responding"}
          >
            Run <span className="kbd">↵</span>
          </button>
        </div>
      </div>
      {errors.length > 0 ? (
        <div className="mapmore" style="color:var(--fail);padding-top:8px">
          {errors.join(" · ")}
        </div>
      ) : null}
    </div>
  );
}
