import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ArrowClockwise, ArrowCounterClockwise, ThumbsDown, ThumbsUp, X } from "@phosphor-icons/react";
import "./photo-actions.css";

const PHOTO_API = "/api/import/photos";

async function readResponse(response) {
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Could not update this photo. Try again.");
  if (!Array.isArray(result.photos)) throw new Error("The photo information is incomplete. Try again.");
  return result.photos;
}

// Keep photo history separate from the garment editor, so a new image never resets a draft.
export function usePhotoCollection(kind, targetId) {
  const [photos, setPhotos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const requestNumber = useRef(0);
  const loadController = useRef(null);
  const mutationPending = useRef(false);
  const mounted = useRef(false);
  const base = `${PHOTO_API}/${kind}/${encodeURIComponent(targetId)}`;

  const refresh = useCallback(async () => {
    if (mutationPending.current) return;
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    const number = ++requestNumber.current;
    try {
      const nextPhotos = await readResponse(await fetch(base, { cache: "no-store", signal: controller.signal }));
      if (mounted.current && number === requestNumber.current) {
        setPhotos(nextPhotos);
        setError("");
      }
    } catch (requestError) {
      if (requestError.name !== "AbortError" && mounted.current && number === requestNumber.current) setError(requestError.message);
    } finally {
      if (mounted.current && number === requestNumber.current) setLoading(false);
    }
  }, [base]);

  useEffect(() => {
    mounted.current = true;
    setPhotos([]);
    setLoading(true);
    setError("");
    refresh();
    return () => {
      mounted.current = false;
      ++requestNumber.current;
      loadController.current?.abort();
    };
  }, [refresh]);

  const generating = photos.some((photo) => photo.generating);
  useEffect(() => {
    if (!generating) return;
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  }, [generating, refresh]);

  const act = useCallback(async (action, body) => {
    if (mutationPending.current) return false;
    mutationPending.current = true;
    loadController.current?.abort();
    const number = ++requestNumber.current;
    setPending(true);
    setError("");
    try {
      const nextPhotos = await readResponse(await fetch(`${base}/${action}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      }));
      if (mounted.current && number === requestNumber.current) setPhotos(nextPhotos);
      return true;
    } catch (requestError) {
      if (mounted.current && number === requestNumber.current) setError(requestError.message);
      return false;
    } finally {
      mutationPending.current = false;
      if (mounted.current && number === requestNumber.current) setPending(false);
    }
  }, [base]);

  return { photos, loading, pending, error, refresh, act };
}

function PhotoDialog({ title, busy, onClose, children }) {
  const dialogRef = useRef(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      className="photo-dialog"
      ref={dialogRef}
      aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}
      onKeyDown={(event) => { if (event.key === "Escape") event.stopPropagation(); }}
      onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}
    >
      <div className="photo-dialog__content">
        <div className="photo-dialog__heading">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="photo-dialog__close" aria-label="Close photo dialog" disabled={busy} onClick={onClose}><X size={20} aria-hidden="true" /></button>
        </div>
        {children}
      </div>
    </dialog>
  );
}

export function PhotoActions({ collection, photo, disabled = false, disabledReason = "" }) {
  const [dialog, setDialog] = useState(null);
  const [rating, setRating] = useState("up");
  const [comment, setComment] = useState("");
  const [direction, setDirection] = useState("");
  const [now, setNow] = useState(Date.now());
  const [savedNotice, setSavedNotice] = useState("");
  const versionId = photo?.versionId;
  const mode = photo?.mode;
  const busy = collection.pending || photo?.generating || disabled;
  const expiresAt = photo?.undo?.expiresAt ? Date.parse(photo.undo.expiresAt) : 0;
  const remaining = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  const available = !!versionId && !collection.loading;

  useEffect(() => {
    setDialog(null);
    setSavedNotice("");
    setNow(Date.now());
  }, [versionId, mode]);
  useEffect(() => {
    if (!expiresAt) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [expiresAt]);

  const openFeedback = (nextRating) => {
    setRating(nextRating);
    setComment(photo.feedback?.comment || "");
    setSavedNotice("");
    setDialog({ type: "feedback", versionId, mode });
  };
  const openRegeneration = () => {
    setDirection("");
    setSavedNotice("");
    setDialog({ type: "regenerate", versionId, mode });
  };
  const submit = async (event) => {
    event.preventDefault();
    if (busy || !dialog || dialog.versionId !== versionId || dialog.mode !== mode) return;
    const success = dialog.type === "feedback"
      ? await collection.act("feedback", { versionId: dialog.versionId, rating, comment: comment.trim() })
      : await collection.act("regenerate", { mode: dialog.mode, expectedVersionId: dialog.versionId, direction: direction.trim() });
    if (success) {
      setDialog(null);
      setSavedNotice(dialog.type === "feedback" ? "Feedback saved for this photo." : "Creating a new photo. You can keep browsing.");
    }
  };
  const undo = async () => {
    if (busy || remaining <= 0) return;
    if (await collection.act("undo", { mode, expectedVersionId: versionId })) setSavedNotice("Previous photo restored.");
  };

  return (
    <section className="photo-actions" aria-label="Photo feedback and regeneration">
      <div className="photo-actions__row">
        <div className="photo-actions__ratings" role="group" aria-label="Rate this photo">
          <button type="button" className={photo?.feedback?.rating === "up" ? "is-selected" : ""} disabled={!available || busy} onClick={() => openFeedback("up")} aria-label="Like this photo" aria-pressed={photo?.feedback?.rating === "up"} title="Like this photo"><ThumbsUp size={19} weight={photo?.feedback?.rating === "up" ? "fill" : "regular"} aria-hidden="true" /></button>
          <button type="button" className={photo?.feedback?.rating === "down" ? "is-selected" : ""} disabled={!available || busy} onClick={() => openFeedback("down")} aria-label="Dislike this photo" aria-pressed={photo?.feedback?.rating === "down"} title="Dislike this photo"><ThumbsDown size={19} weight={photo?.feedback?.rating === "down" ? "fill" : "regular"} aria-hidden="true" /></button>
        </div>
        <button type="button" className="secondary-button photo-actions__regenerate" disabled={!available || busy} onClick={openRegeneration}><ArrowClockwise size={16} aria-hidden="true" />{photo?.generating ? "Creating photo…" : "Regenerate"}</button>
      </div>
      {remaining > 0 && !photo?.generating && <div className="photo-actions__undo" role="status">
        <span>New photo ready. Undo available for {remaining}s.</span>
        <button type="button" disabled={busy} onClick={undo}><ArrowCounterClockwise size={15} aria-hidden="true" /> Undo</button>
      </div>}
      <p className="photo-actions__note">{disabledReason || (photo?.generating ? "Your current photo stays here while the new one is created." : "Photos and feedback are saved for future styling improvements.")}</p>
      {savedNotice && <p className="photo-actions__status" role="status">{savedNotice}</p>}
      {(collection.error || photo?.error) && <div className="photo-actions__error" role="alert"><p>{collection.error || photo.error}</p>{collection.error && <button type="button" disabled={collection.pending} onClick={collection.refresh}>Try again</button>}</div>}
      {dialog && <PhotoDialog title={dialog.type === "feedback" ? (rating === "up" ? "What works well?" : "What could be better?") : "Create a new photo"} busy={collection.pending} onClose={() => setDialog(null)}>
        <form onSubmit={submit}>
          <p className="photo-dialog__intro">{dialog.type === "feedback" ? "Your feedback stays with this exact photo. Add a note to help improve future styling." : "Suggest a change, or leave this blank for another take. Your previous photo is kept, and you can undo for one minute after the new photo is ready."}</p>
          <label className="field photo-dialog__field">
            <span>{dialog.type === "feedback" ? "Comment (optional)" : "What would you like to change? (optional)"}</span>
            <textarea autoFocus rows={4} maxLength={2000} value={dialog.type === "feedback" ? comment : direction} onChange={(event) => dialog.type === "feedback" ? setComment(event.target.value) : setDirection(event.target.value)} placeholder={dialog.type === "feedback" ? "Fit, proportions, colors, or anything else…" : "For example, use a simpler inner layer or improve the fit…"} disabled={collection.pending} />
          </label>
          {collection.error && <p className="photo-actions__error" role="alert">{collection.error}</p>}
          <div className="photo-dialog__footer">
            <button type="button" className="secondary-button" disabled={collection.pending} onClick={() => setDialog(null)}>Cancel</button>
            <button type="submit" className="primary-button" disabled={collection.pending}>{collection.pending ? (dialog.type === "feedback" ? "Saving…" : "Starting…") : dialog.type === "feedback" ? "Save feedback" : "Regenerate photo"}</button>
          </div>
        </form>
      </PhotoDialog>}
    </section>
  );
}

export function PromptCalibrationControl() {
  const [calibration, setCalibration] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/import/prompt-calibration", { cache: "no-store", signal: controller.signal })
      .then((response) => response.ok ? response.json() : null)
      .then(setCalibration)
      .catch(() => {});
    return () => controller.abort();
  }, []);
  const reset = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/import/prompt-calibration/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Could not restore the default styling.");
      setCalibration(result);
    } catch (requestError) { setError(requestError.message); }
    finally { setBusy(false); }
  };
  if (!calibration || calibration.isDefault) return null;
  return <div className="prompt-calibration-control"><span>Personalized styling is active.</span><button type="button" disabled={busy} onClick={reset}>{busy ? "Restoring…" : "Restore default styling"}</button>{error && <p role="alert">{error}</p>}</div>;
}
