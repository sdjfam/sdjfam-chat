import type { Dispatch, ReactNode, SetStateAction } from "react";

type SettingsProps = {
  setSettingsOpen: Dispatch<SetStateAction<boolean>>;
  children: ReactNode;
};

export function Settings({ setSettingsOpen, children }: SettingsProps) {
  return (<div
    className="settings-backdrop"
    onMouseDown={() =>
      setSettingsOpen(
        false
      )
    }
  >
    <aside
      className="settings-panel"
      onMouseDown={(
        event
      ) =>
        event.stopPropagation()
      }
    >
      {/* Header */}

      <div className="settings-header">
        <div>
          <h2>
            Settings
          </h2>

          <p>
            SDJFAM Chat instellingen
          </p>
        </div>

        <button
          type="button"
          className="settings-close"
          onClick={() =>
            setSettingsOpen(
              false
            )
          }
          aria-label="Settings sluiten"
        >
          ×
        </button>
      </div>



      {children}
    </aside>
  </div>);
}
