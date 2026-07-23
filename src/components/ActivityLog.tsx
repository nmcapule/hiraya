import { useDeferredValue, useEffect, useRef, useState } from "react";
import { MagnifyingGlass, SpinnerGap, X } from "@phosphor-icons/react";
import type { ActivityPage, ActivityQuery, ActivityRecord } from "../lib/activity";

type Props = {
  onListActivity: (query?: ActivityQuery) => Promise<ActivityPage>;
  onSubscribe: (listener: () => void) => () => void;
};

function formatAction(action: string) {
  return action.replaceAll("-", " ");
}

function formatSource(source: string) {
  if (source === "api") return "Shared desktop";
  if (source === "filesystem") return "Files directory";
  if (source === "frontend") return "This browser";
  return source;
}

export function ActivityLog({ onListActivity, onSubscribe }: Props) {
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search.trim());
  const [activities, setActivities] = useState<ActivityRecord[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState("");
  const [refreshToken, setRefreshToken] = useState(0);
  const requestRef = useRef(0);

  useEffect(() => onSubscribe(() => setRefreshToken((value) => value + 1)), [onSubscribe]);

  useEffect(() => {
    const request = ++requestRef.current;
    setLoading(true);
    setLoadingOlder(false);
    setError("");
    void onListActivity({ q: deferredSearch || undefined }).then((page) => {
      if (request !== requestRef.current) return;
      setActivities(page.activities);
      setNextBefore(page.nextBefore);
    }).catch((reason: unknown) => {
      if (request !== requestRef.current) return;
      setActivities([]);
      setNextBefore(null);
      setError(reason instanceof Error ? reason.message : "Activity could not be loaded.");
    }).finally(() => {
      if (request === requestRef.current) setLoading(false);
    });
  }, [deferredSearch, onListActivity, refreshToken]);

  const loadOlder = async () => {
    if (nextBefore === null || loadingOlder) return;
    const request = ++requestRef.current;
    setLoadingOlder(true);
    setError("");
    try {
      const page = await onListActivity({ q: deferredSearch || undefined, before: nextBefore });
      if (request !== requestRef.current) return;
      setActivities((current) => [...current, ...page.activities]);
      setNextBefore(page.nextBefore);
    } catch (reason) {
      if (request === requestRef.current) setError(reason instanceof Error ? reason.message : "Older activity could not be loaded.");
    } finally {
      if (request === requestRef.current) setLoadingOlder(false);
    }
  };

  return (
    <div className="activity-log">
      <label className="activity-search">
        <MagnifyingGlass size={16} aria-hidden="true" />
        <span className="sr-only">Search activity</span>
        <input type="search" value={search} maxLength={200} placeholder="Search changes, names, or values" onChange={(event) => setSearch(event.target.value)} />
        {search && <button type="button" aria-label="Clear activity search" onClick={() => setSearch("")}><X size={14} /></button>}
      </label>

      {loading ? (
        <div className="activity-state" role="status"><SpinnerGap size={19} className="activity-spinner" /> Loading activity...</div>
      ) : error && activities.length === 0 ? (
        <div className="activity-state activity-state--error" role="alert"><span>{error}</span><button className="button button--quiet" type="button" onClick={() => setRefreshToken((value) => value + 1)}>Retry</button></div>
      ) : activities.length === 0 ? (
        <div className="activity-state" role="status">{deferredSearch ? "No activity matches this search." : "No desktop activity has been recorded yet."}</div>
      ) : (
        <>
          <span className="sr-only" role="status">{activities.length} activity {activities.length === 1 ? "record" : "records"} shown{deferredSearch ? " for this search" : ""}.</span>
          <ol className="activity-list" aria-label="Desktop activity">
            {activities.map((activity) => (
              <li className="activity-item" key={activity.catalogRevision}>
                <div className="activity-item__rail" aria-hidden="true"><span /></div>
                <div className="activity-item__content">
                  {"broken" in activity ? (
                    <>
                      <div className="activity-item__meta"><span className="activity-item__action">broken</span></div>
                      <strong>This activity record could not be read.</strong>
                      <small>Catalog revision {activity.catalogRevision}</small>
                    </>
                  ) : (
                    <>
                      <div className="activity-item__meta">
                        <span className="activity-item__action">{formatAction(activity.action)}</span>
                        <time dateTime={new Date(activity.timestamp).toISOString()}>{new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(activity.timestamp)}</time>
                      </div>
                      <strong>{activity.summary}</strong>
                      {activity.details.length > 0 && <p>{activity.details.join(" · ")}</p>}
                      <small>{formatSource(activity.source)} · Catalog revision {activity.catalogRevision}</small>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ol>
          {error && <div className="activity-state activity-state--error" role="alert"><span>{error}</span><button className="button button--quiet" type="button" onClick={() => void loadOlder()}>Retry</button></div>}
          {nextBefore !== null && <button className="button button--quiet activity-load-more" type="button" disabled={loadingOlder} onClick={() => void loadOlder()}>{loadingOlder ? "Loading" : "Load older"}</button>}
        </>
      )}
    </div>
  );
}
