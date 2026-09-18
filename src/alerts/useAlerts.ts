import { useCallback, useEffect, useState } from "react";
import type { SdjfamEvent } from "../types/events";

export function useAlerts() {
  const [
    activeAlert,
    setActiveAlert,
  ] =
    useState<SdjfamEvent | null>(null);

  const [
    alertQueue,
    setAlertQueue,
  ] =
    useState<SdjfamEvent[]>([]);

  const [
    alertHistory,
    setAlertHistory,
  ] =
    useState<SdjfamEvent[]>([]);

  const pushAlert = useCallback((
    event: SdjfamEvent
  ) => {
    // Voeg het event toe aan de bestaande overlay-wachtrij.
    setAlertQueue(
      (currentQueue) => [
        ...currentQueue,
        event,
      ]
    );

    // Bewaar het event ook in de zichtbare Alerts & Gifts-history.
    // Nieuwste event staat bovenaan.
    // Maximaal 100 events bewaren.
    setAlertHistory(
      (currentHistory) => [
        event,
        ...currentHistory,
      ].slice(0, 100)
    );
  }, []);

  useEffect(() => {
    if(!activeAlert) {
      return;
    }

    const timer =
      window.setTimeout(() => {
        setActiveAlert(null);
      }, 5000);

    return () => {
      window.clearTimeout(timer);
    };
  }, [activeAlert]);

  useEffect(() => {
    if(
      activeAlert ||
      alertQueue.length === 0
    ) {
      return;
    }

    const nextAlert =
      alertQueue[0];

    setActiveAlert(
      nextAlert
    );

    setAlertQueue(
      (currentQueue) =>
        currentQueue.slice(1)
    );
  }, [
    activeAlert,
    alertQueue,
  ]);
  return {
    activeAlert,
    alertHistory,
    pushAlert
  };
}
