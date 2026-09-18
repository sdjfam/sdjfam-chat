import { check } from "@tauri-apps/plugin-updater";
import { useEffect, useRef, useState } from "react";
import { diagnosticError, diagnosticLog, recordDiagnosticEvent } from "../diagnostics";

export function useUpdater() {
  const [
    updateVersion,
    setUpdateVersion,
  ] =
    useState<string | null>(null);

  const [
    updateInstalling,
    setUpdateInstalling,
  ] =
    useState(false);

  const [
    updateStatus,
    setUpdateStatus,
  ] =
    useState("");

  const [
    updateNotes,
    setUpdateNotes,
  ] =
    useState("");

  const [
    updatePopupOpen,
    setUpdatePopupOpen,
  ] =
    useState(false);

  const updateRef =
    useRef<
      Awaited<
        ReturnType<typeof check>
      >
    >(null);

  useEffect(() => {
    let cancelled = false;

    async function checkForUpdates() {
      diagnosticLog(
        "UPDATER",
        "Update check started"
      );

      recordDiagnosticEvent(
        "app",
        "updater",
        {
          action: "check_started",
        }
      );

      try {
        const update =
          await check({
            timeout: 30000,
          });

        if(cancelled) {
          if(update) {
            await update
              .close()
              .catch(() => { });
          }

          return;
        }

        if(!update) {
          updateRef.current = null;

          setUpdateVersion(null);
          setUpdateNotes("");
          setUpdatePopupOpen(false);
          setUpdateStatus("");

          recordDiagnosticEvent(
            "app",
            "updater",
            {
              action:
                "no_update_available",
            }
          );

          return;
        }

        updateRef.current =
          update;

        setUpdateVersion(
          update.version
        );

        const notes =
          typeof update.body ===
            "string"
            ? update.body.trim()
            : "";

        setUpdateNotes(
          notes ||
          "Deze update bevat verbeteringen en bugfixes."
        );

        setUpdatePopupOpen(true);

        setUpdateStatus(
          `Versie ${update.version} is beschikbaar`
        );

        recordDiagnosticEvent(
          "app",
          "updater",
          {
            action:
              "update_available",
            version:
              update.version,
          }
        );
      } catch(error) {
        console.warn(
          "Updatecontrole niet beschikbaar:",
          error
        );

        diagnosticError(
          "UPDATER",
          error
        );
      }
    }

    void checkForUpdates();

    return () => {
      cancelled = true;
    };
  }, []);

  async function handleInstallUpdate() {
    const update =
      updateRef.current;

    if(
      !update ||
      updateInstalling
    ) {
      return;
    }

    try {
      setUpdateInstalling(true);

      recordDiagnosticEvent(
        "app",
        "updater",
        {
          action:
            "install_started",
          version:
            update.version,
        }
      );

      setUpdateStatus(
        `Update ${update.version} downloaden...`
      );

      let downloaded = 0;

      let contentLength:
        | number
        | undefined;

      await update.downloadAndInstall(
        (event) => {
          switch(
          event.event
          ) {
            case "Started":
              contentLength =
                event.data
                  .contentLength;

              diagnosticLog(
                "UPDATER",
                `download_started version=${update.version}`
              );

              setUpdateStatus(
                `Update ${update.version} downloaden...`
              );

              break;

            case "Progress":
              downloaded +=
                event.data
                  .chunkLength;

              if(
                contentLength &&
                contentLength > 0
              ) {
                const percentage =
                  Math.min(
                    100,
                    Math.round(
                      (
                        downloaded /
                        contentLength
                      ) * 100
                    )
                  );

                setUpdateStatus(
                  `Update ${update.version} downloaden... ${percentage}%`
                );
              }

              break;

            case "Finished":
              diagnosticLog(
                "UPDATER",
                `download_finished version=${update.version}`
              );

              setUpdateStatus(
                "Update gedownload. Installeren..."
              );

              break;
          }
        }
      );

      setUpdateStatus(
        "Update wordt geïnstalleerd..."
      );

      recordDiagnosticEvent(
        "app",
        "updater",
        {
          action:
            "install_triggered",
          version:
            update.version,
        }
      );
    } catch(error) {
      console.error(
        "Update installeren mislukt:",
        error
      );

      diagnosticError(
        "UPDATER",
        error
      );

      setUpdateStatus(
        `Update mislukt: ${String(
          error
        )}`
      );

      setUpdateInstalling(false);
    }
  }
  return {
    updateVersion,
    updateInstalling,
    updateStatus,
    updateNotes,
    updatePopupOpen,
    setUpdatePopupOpen,
    handleInstallUpdate
  };
}
