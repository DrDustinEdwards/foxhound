import { useId } from "react";
import { Switch } from "capsomer/react/switch";
import "capsomer/switch.css";

/** One of Recova's toggle rows: the label and its line on the left, the
 *  switch on the right, a rule above all but the first row. The switch is named
 *  by the row's label and described by its line. Shared by
 *  /settings/notifications and /settings/email. */
export function ToggleRow({
  name,
  label,
  help,
  defaultChecked,
  first,
}: {
  name: string;
  label: string;
  help: string;
  defaultChecked: boolean;
  /** The first row of a card has no rule above it. */
  first?: boolean;
}) {
  const base = useId();
  const labelId = `${base}-label`;
  const helpId = `${base}-help`;
  return (
    <div className={first ? "py-4" : "border-t border-border py-4"}>
      <div className="cap-field" data-orientation="horizontal">
        <div className="cap-field-content">
          <span className="cap-field-title" id={labelId}>
            {label}
          </span>
          <p className="cap-field-description" id={helpId}>
            {help}
          </p>
        </div>
        <Switch
          name={name}
          label={null}
          defaultChecked={defaultChecked}
          aria-labelledby={labelId}
          aria-describedby={helpId}
        />
      </div>
    </div>
  );
}
