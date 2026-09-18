import type * as React from "react";

type UpdatePopupProps = {
  updateVersion: string | null;
  updateNotes: string;
  updateInstalling: boolean;
  updateStatus: string;
  setUpdatePopupOpen: React.Dispatch<React.SetStateAction<boolean>>;
  handleInstallUpdate: () => Promise<void>;
};

export function UpdatePopup({
  updateVersion,
  updateNotes,
  updateInstalling,
  updateStatus,
  setUpdatePopupOpen,
  handleInstallUpdate
}: UpdatePopupProps) {
  return (<div
    className="update-popup-backdrop"
    role="dialog"
    aria-modal="true"
    aria-labelledby="update-popup-title"
  >
    <div className="update-popup">
      <div className="update-popup-label">
        SDJFAM CHAT UPDATE
      </div>

      <h2 id="update-popup-title">
        Nieuwe update beschikbaar
      </h2>

      <p className="update-popup-version">
        Versie {updateVersion} staat klaar.
      </p>

      <div className="update-popup-notes">
        <strong>
          Wat is er nieuw?
        </strong>

        <div>
          {updateNotes}
        </div>
      </div>

      {updateInstalling &&
        updateStatus && (
          <p className="update-popup-status">
            {updateStatus}
          </p>
        )}

      <div className="update-popup-actions">
        <button
          type="button"
          className="update-popup-later"
          onClick={() =>
            setUpdatePopupOpen(
              false
            )
          }
          disabled={
            updateInstalling
          }
        >
          Later
        </button>

        <button
          type="button"
          className="update-popup-now"
          onClick={() =>
            void handleInstallUpdate()
          }
          disabled={
            updateInstalling
          }
        >
          {updateInstalling
            ? "Update installeren..."
            : "Nu updaten"}
        </button>
      </div>
    </div>
  </div>);
}
