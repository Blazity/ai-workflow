"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import type {
  IntegrationConnectionFieldDto,
  IntegrationConnectionSaveRequest,
  IntegrationDto,
  IntegrationImpactPreviewRequest,
  IntegrationImpactPreviewResponse,
  IntegrationMutationResponse,
  IntegrationSource,
  IntegrationVersionConflict,
  IntegrationWriteAccess,
  SystemHealthResponse,
} from "@shared/contracts";

import { useCockpit } from "@/components/cockpit/context";
import { Button, CkChip, Field, Input, Switch, Textarea, Modal } from "@/components/ui";
import { apiClient } from "@/lib/api/client";
import { browserHandlesClick } from "@/lib/cockpit/navigation";
import { useUnsavedWork } from "@/lib/settings/use-unsaved-work";
import {
  publishIntegrationChange,
  useIntegrationChangeRefresh,
} from "@/lib/integrations/change-signal";
import {
  andList,
  buildSaveRequest,
  conflictDifferenceLines,
  disableConsequence,
  disconnectConsequence,
  enableConsequence,
  availabilityInsteadOfSwitch,
  fieldHint,
  nothingToDisconnectLine,
  sourceInUse,
  SECRETS_KEY_SETUP_URL,
  secretsKeyNotice,
  integrationImpactConfirmLabel,
  integrationImpactLines,
  missingRequiredFields,
  readableProviderText,
  sourceSwitchRefusal,
  statusChip,
  statusDetailLines,
  storesValues,
  testOutcomeLines,
  testRefusal,
  unlocksLines,
  versionConflictLine,
  waitingOnProviderLine,
  CHANGED_ELSEWHERE_LINE,
  CONFLICT_REREAD_FAILED_LINE,
  MEMBER_READ_ONLY_LINE,
  READING_IMPACT_LINE,
  type IntegrationImpactAction,
  type IntegrationTone,
} from "@/lib/integrations/presentation";

/**
 * The one screen where a credential is typed.
 *
 * Three sections in the order the work happens: the values, then where the
 * values in use come from, then the switches that take the integration away.
 * A first connection never has to read past the first section.
 *
 * What the admin typed belongs to the admin: the form seeds itself once and is
 * never re-seeded from a later server render, because the cockpit refreshes
 * itself on a timer when Live is on and a form that emptied under a hand on the
 * keyboard is worse than a stale label. Everything that is not typed (status,
 * source, versions, what the provider said) is the server's and is replaced
 * from every response.
 *
 * A save refused for a version conflict is the one exception, and it is the
 * opposite case: the fields nobody here has touched are taken from the values
 * that won, because seeding them once was what made "Save again" hand back a
 * colleague's change as this admin's.
 */

const CHIP_TONES: Record<IntegrationTone, "success" | "failed" | "neutral" | "blocked"> = {
  success: "success",
  failed: "failed",
  quiet: "blocked",
  off: "neutral",
};

type NoticeTone = "good" | "bad" | "plain";

interface Notice {
  readonly tone: NoticeTone;
  readonly lines: readonly string[];
}

const NOTICE_CLASSES: Record<NoticeTone, string> = {
  good: "border-[#BEE0AE] bg-success-bg text-success-fg",
  bad: "border-[#F0B8AE] bg-fail-bg text-fail-fg",
  plain: "border-neutral-200 bg-app-bg text-neutral-700",
};

function seedValues(
  fields: readonly IntegrationConnectionFieldDto[],
): Record<string, string> {
  const seed: Record<string, string> = {};
  for (const field of fields) seed[field.key] = field.secret ? "" : field.storedValue ?? "";
  return seed;
}

function isConflict(
  body: IntegrationMutationResponse | IntegrationVersionConflict,
): body is IntegrationVersionConflict {
  return "error" in body && body.error === "integration_version_conflict";
}

const INTEGRATIONS_HREF = "/integrations";

/**
 * The way back, in the shape the run trace already uses for the same job
 * (`screens/trace.tsx`): an arrow, the name of the list, and no chrome. A link
 * rather than that screen's button, because this one changes the URL and so has
 * to survive a middle click and a bookmark.
 *
 * A plain click goes through the cockpit's `navigate`, the way a sidebar entry
 * does: the anchor alone is a full document navigation, which walked past the
 * guard that asks before a half-typed token is thrown away.
 */
function BackToIntegrations() {
  const { navigate } = useCockpit();
  return (
    <Button
      variant="text"
      href={INTEGRATIONS_HREF}
      onClick={(event) => {
        if (browserHandlesClick(event)) return;
        event.preventDefault();
        navigate(INTEGRATIONS_HREF);
      }}
      className="self-start border-0 bg-transparent p-0 font-mono text-[11px] uppercase tracking-[0.04em] text-mariner no-underline hover:underline"
    >
      ← Integrations
    </Button>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[4px] border border-neutral-200 bg-panel px-4 py-3 flex flex-col gap-3">
      <div className="flex flex-col gap-[2px]">
        <h3 className="m-0 font-display text-[16px] font-medium text-coal">{title}</h3>
        {description && (
          <p className="m-0 font-body text-[12px] text-neutral-600">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}

function NoticePanel({ notice }: { notice: Notice }) {
  return (
    <div
      role="status"
      className={`rounded-[3px] border px-3 py-2 font-body text-[12px] flex flex-col gap-1 break-words ${NOTICE_CLASSES[notice.tone]}`}
    >
      {/* Keyed by position: two lines of a notice can legitimately read the
          same, and a duplicate key drops one of them. */}
      {notice.lines.map((line, index) => (
        <span key={index}>{line}</span>
      ))}
    </div>
  );
}

function ConfirmDialog({
  title,
  lines,
  confirmLabel,
  busy,
  onConfirm,
  onClose,
}: {
  title: string;
  lines: readonly string[];
  confirmLabel: string;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal title={title} onClose={onClose} size="sm">
      <div className="flex flex-col gap-2 font-body text-[13px] text-neutral-800">
        {lines.map((line, index) => (
          <p key={index} className="m-0">
            {line}
          </p>
        ))}
        <div className="mt-2 flex gap-2">
          {/* Every confirmation here takes something away: runs in flight,
              stored credentials, or the integration itself. */}
          <Button variant="danger" loading={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function ConnectionScreen({
  integration: initialIntegration,
  writes,
  canManage,
  scan = null,
}: {
  integration: IntegrationDto;
  writes: IntegrationWriteAccess;
  /** canManageIntegrations(role): owners and admins. */
  canManage: boolean;
  /** The last stored health scan, when this role could read one. */
  scan?: SystemHealthResponse | null;
}) {
  const router = useRouter();
  const [integration, setIntegration] = useState(initialIntegration);
  const [values, setValues] = useState(() => seedValues(initialIntegration.fields));
  const [clearedSecrets, setClearedSecrets] = useState<string[]>([]);
  const [busy, setBusy] = useState<
    null | "impact" | "save" | "test" | "enabled" | "source" | "disconnect"
  >(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [missing, setMissing] = useState<string[]>([]);
  const [confirming, setConfirming] = useState<IntegrationImpactAction | null>(null);
  const [impact, setImpact] = useState<IntegrationImpactPreviewResponse | null>(null);
  const [pendingSave, setPendingSave] = useState<IntegrationConnectionSaveRequest | null>(null);
  const [pendingSource, setPendingSource] = useState<IntegrationSource | null>(null);
  // Set when this page stopped following the server because somebody was
  // typing. State rather than a ref: it is on screen.
  const [dirty, setDirty] = useState(false);
  const [changedElsewhere, setChangedElsewhere] = useState(false);
  const inFlight = useRef(false);
  // Which impact read is the live one. Closing the dialog moves it on, so a
  // read that lands after the admin cancelled finds itself stale and neither
  // shows its answer nor makes the change it was asked about.
  const previewToken = useRef(0);
  // Which inputs this admin has been in. Only used when a conflict has to
  // decide whose value an input holds, so it is a ref: touching a field is not
  // a reason to re-render.
  const touched = useRef(new Set<string>());

  // A fresh server render supersedes the state held here. The typed values are
  // deliberately not part of this: they are the admin's, not the server's.
  useEffect(() => setIntegration(initialIntegration), [initialIntegration]);
  // Another tab disconnecting this integration is the case that matters: this
  // screen would otherwise keep reading Connected and keep offering a
  // Disconnect for values that are already gone. While something is typed the
  // refresh would empty the form instead, so the page says so and stays put,
  // which also leaves the version this save will collide with.
  useIntegrationChangeRefresh({
    enabled: !dirty,
    onSuppressed: () => setChangedElsewhere(true),
  });
  // Leaving with a half-typed token asks first: by a sidebar entry, a tab of
  // this area, a spotlight jump or the link back (the cockpit's guard), and by
  // a reload or a closed tab (the browser's).
  useUnsavedWork(`integration:${integration.id}`, dirty);

  function typeInto(key: string, value: string) {
    touched.current.add(key);
    setDirty(true);
    setValues((current) => ({ ...current, [key]: value }));
  }

  function forgetTypedWork() {
    touched.current.clear();
    setDirty(false);
    setChangedElsewhere(false);
  }

  const state = integration.state;
  const chip = statusChip(state);
  const writable = canManage && writes.allowed;
  const stored = storesValues(integration);

  function applied(next: IntegrationDto) {
    setIntegration(next);
    publishIntegrationChange();
    router.refresh();
  }

  async function run<T>(
    key: NonNullable<typeof busy>,
    call: () => Promise<T>,
    onResult: (result: T) => void | Promise<void>,
    onSettled?: () => void,
  ) {
    // A ref rather than the `busy` state: two clicks land in one React batch,
    // so the second one reads the state the first one has not committed yet and
    // a double click stores two versions and runs two connection tests. The
    // disabled button is what a person sees; this is what actually holds.
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(key);
    setNotice(null);
    try {
      await onResult(await call());
    } catch {
      setNotice({
        tone: "bad",
        lines: ["The dashboard could not reach the worker. Nothing was changed. Try again."],
      });
    } finally {
      inFlight.current = false;
      setBusy(null);
      // Settled means settled, refused as well as done. A confirmation dialog
      // left open covers the notice it was refused with, which is how a member
      // clicking Turn it off saw the switch snap back and no reason at all.
      onSettled?.();
    }
  }

  /**
   * A save the worker refused because somebody else saved first.
   *
   * The 409 carries only the version that won, so the connection is read back
   * and the form is put next to it: an input nobody here has touched takes the
   * value that is now stored, so saving again cannot quietly undo a colleague's
   * change, and every input that still differs is named with both values. Only
   * then is Save offered again, and by then it carries the version that won, so
   * the second attempt is a decision instead of a second race.
   */
  async function handleConflict() {
    const reread = await apiClient.integrations.list();
    const fresh = reread.ok
      ? reread.data.integrations.find((candidate) => candidate.id === integration.id)
      : undefined;
    if (!fresh) {
      setNotice({
        tone: "bad",
        lines: [versionConflictLine(integration), CONFLICT_REREAD_FAILED_LINE],
      });
      return;
    }
    const merged = { ...values };
    for (const field of fresh.fields) {
      if (field.secret || touched.current.has(field.key)) continue;
      merged[field.key] = field.storedValue ?? "";
    }
    setIntegration(fresh);
    setValues(merged);
    setChangedElsewhere(false);
    setNotice({
      tone: "bad",
      lines: [
        versionConflictLine(fresh),
        ...conflictDifferenceLines({
          fields: fresh.fields,
          values: merged,
          clearedSecrets,
          state: fresh.state,
        }),
      ],
    });
    router.refresh();
  }

  function performSave(request: IntegrationConnectionSaveRequest) {
    void run(
      "save",
      () => apiClient.integrations.save(integration.id, request),
      async (result) => {
        if (!result.ok) {
          setNotice({ tone: "bad", lines: [readableProviderText(result.errorMessage)] });
          return;
        }
        if (isConflict(result.data)) {
          await handleConflict();
          return;
        }
        const next = result.data.integration;
        setIntegration(next);
        setClearedSecrets([]);
        // What was typed is now what is stored, so nothing on this form is
        // still the admin's own unsaved value for a conflict to protect.
        forgetTypedWork();
        // A stored secret is never echoed back, so the inputs that carried one
        // are emptied: leaving the typed characters on screen would suggest the
        // field holds the value, which is the one thing it must never claim.
        setValues((current) => {
          const cleaned = { ...current };
          for (const field of next.fields) if (field.secret) cleaned[field.key] = "";
          return cleaned;
        });
        const outcome = result.data.test;
        setNotice(
          outcome === undefined
            ? { tone: "plain", lines: ["Saved."] }
            : {
                tone: outcome.ok ? "good" : "bad",
                lines: [
                  ...testOutcomeLines(outcome, next, "save"),
                  // What connecting adds, only when these values are the ones
                  // in use; stored beside a working environment they add nothing.
                  ...(outcome.ok && next.state.source === "stored" ? unlocksLines(next) : []),
                ],
              },
        );
        publishIntegrationChange();
        router.refresh();
      },
      closeConfirmation,
    );
  }

  /**
   * Read what a change would stop before making it (decision 9), with the
   * confirmation open and saying so while the read is out.
   *
   * `unlessRunsStop` is the change itself, for the two kinds a run follows
   * when nothing it holds breaks: a save and a switch of source. When the
   * worker says no run in flight may stop, that change goes ahead without a
   * question nobody needs to answer. Disconnect and the kill switch always
   * ask, because each takes something away whatever runs do.
   *
   * Cancelling while the read is out is final: the admin said no before the
   * answer came, and "nothing stops" is not a yes. A switch of source that
   * stops no run can still hand every later run a different token.
   */
  async function previewChange(
    preview: IntegrationImpactPreviewRequest,
    action: IntegrationImpactAction,
    unlessRunsStop?: () => void,
  ) {
    if (inFlight.current) return;
    inFlight.current = true;
    const token = ++previewToken.current;
    setBusy("impact");
    setImpact(null);
    setConfirming(action);
    let proceed: (() => void) | null = null;
    try {
      const result = await apiClient.integrations.previewImpact(integration.id, preview);
      if (token !== previewToken.current) return;
      if (result.ok) {
        setImpact(result.data);
        const noRunStops = result.data.stops === "none" || result.data.inFlightRuns === 0;
        if (noRunStops && unlessRunsStop) {
          proceed = unlessRunsStop;
          closeConfirmation();
        }
      }
      // A failed read deliberately leaves impact null. The dialog renders that
      // as unknown and still requires an explicit, accurately labelled choice.
    } catch {
      // requestJson normally returns a failure result; a thrown network error
      // is the same unknown state, never a measured zero.
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
    // After the flag is down: the change takes the same single-flight guard.
    proceed?.();
  }

  function save() {
    const form = { fields: integration.fields, values, clearedSecrets, state };
    const empty = missingRequiredFields(form);
    setMissing(empty);
    if (empty.length > 0) {
      setNotice({
        tone: "bad",
        lines: [`Fill ${andList(empty)} in before saving. Nothing was sent.`],
      });
      return;
    }
    const request = buildSaveRequest(form);
    setPendingSave(request);
    void previewChange({ preview: "save", ...request }, "save", () => performSave(request));
  }

  function closeConfirmation() {
    previewToken.current += 1;
    setConfirming(null);
    setImpact(null);
    setPendingSave(null);
    setPendingSource(null);
  }

  function test() {
    const refusal = testRefusal(integration);
    if (refusal) {
      setNotice({ tone: "plain", lines: [refusal] });
      return;
    }
    void run(
      "test",
      () => apiClient.integrations.test(integration.id),
      (result) => {
        if (!result.ok) {
          setNotice({ tone: "bad", lines: [readableProviderText(result.errorMessage)] });
          return;
        }
        const next = result.data.integration;
        const outcome = result.data.test;
        applied(next);
        setNotice(
          outcome === undefined
            ? { tone: "plain", lines: ["The worker ran no test."] }
            : {
                tone: outcome.ok ? "good" : "bad",
                lines: testOutcomeLines(outcome, next, "test"),
              },
        );
      },
    );
  }

  function setEnabled(enabled: boolean) {
    void run(
      "enabled",
      () => apiClient.integrations.setEnabled(integration.id, enabled),
      (result) => {
        if (!result.ok) {
          setNotice({ tone: "bad", lines: [readableProviderText(result.errorMessage)] });
          return;
        }
        applied(result.data.integration);
        setNotice({
          tone: "plain",
          lines: enabled
            ? [enableConsequence(result.data.integration)]
            : [`${integration.name} is off. ${disableConsequence(integration)[0]}`],
        });
      },
      closeConfirmation,
    );
  }

  /** Switching source moves the pin whenever the two sources differ, so it
   *  is previewed like a save and confirmed only when a run would stop. */
  function switchSource(source: IntegrationSource) {
    setPendingSource(source);
    void previewChange({ preview: "source", source }, "source", () => performSourceSwitch(source));
  }

  function performSourceSwitch(source: IntegrationSource) {
    void run(
      "source",
      () => apiClient.integrations.setSource(integration.id, source),
      (result) => {
        if (!result.ok) {
          setNotice({ tone: "bad", lines: [readableProviderText(result.errorMessage)] });
          return;
        }
        applied(result.data.integration);
        setNotice({
          tone: "plain",
          lines: [
            source === "environment"
              ? "The values in use now come from this deployment's environment variables. Nothing stored here was erased."
              : "The values in use now come from what was stored here. The environment variables are untouched.",
          ],
        });
      },
      closeConfirmation,
    );
  }

  function disconnect() {
    void run(
      "disconnect",
      () => apiClient.integrations.disconnect(integration.id),
      (result) => {
        if (!result.ok) {
          setNotice({ tone: "bad", lines: [readableProviderText(result.errorMessage)] });
          return;
        }
        const next = result.data.integration;
        applied(next);
        setValues(seedValues(next.fields));
        setClearedSecrets([]);
        forgetTypedWork();
        setNotice({ tone: "plain", lines: statusDetailLines(next) });
      },
      closeConfirmation,
    );
  }

  const environmentRefusal = sourceSwitchRefusal(integration, "environment");
  const storedRefusal = sourceSwitchRefusal(integration, "stored");
  const keyNotice = secretsKeyNotice(integration);
  const availabilityNote = availabilityInsteadOfSwitch(integration);

  return (
    <div className="flex flex-col gap-4 px-4 lg:px-6 pt-5 pb-8 max-w-[840px]">
      <div className="flex flex-col gap-1">
        <BackToIntegrations />
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="m-0 font-display text-2xl font-medium leading-[1.2] text-neutral-900">
            {integration.name}
          </h2>
          <CkChip tone={CHIP_TONES[chip.tone]}>{chip.label}</CkChip>
        </div>
        <p className="m-0 font-body text-[13px] text-neutral-600">{integration.description}</p>
        <div className="flex flex-col gap-[2px] mt-1">
          {statusDetailLines(integration, scan).map((line, index) => (
            <span key={index} className="font-body text-[12px] text-neutral-500 break-words">
              {line}
            </span>
          ))}
        </div>
        {integration.docsUrl && (
          <a
            href={integration.docsUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-1 font-mono text-[10px] uppercase tracking-[0.06em] text-mariner no-underline hover:underline"
          >
            Provider docs
          </a>
        )}
      </div>

      {canManage && !writes.allowed && (
        <div
          role="status"
          className="rounded-[3px] border border-orange-300 bg-orange-100 px-3 py-2 font-body text-[12px] text-[#A23E18]"
        >
          {writes.reason} The values below are shown so this deployment can be
          checked against the one that owns the database; nothing here can be
          changed from here.
        </div>
      )}

      {!canManage && (
        <div className="rounded-[3px] border border-neutral-200 bg-app-bg px-3 py-2 font-body text-[12px] text-neutral-600">
          {MEMBER_READ_ONLY_LINE}
        </div>
      )}

      {notice && <NoticePanel notice={notice} />}

      {changedElsewhere && (
        <div
          role="status"
          className="rounded-[3px] border border-orange-300 bg-orange-100 px-3 py-2 font-body text-[12px] text-[#A23E18]"
        >
          {CHANGED_ELSEWHERE_LINE}
        </div>
      )}

      <Section
        title="Values"
        description={
          writable
            ? "Saved values are tested against the provider before anything starts using them. A test that fails leaves the connection in use exactly as it was."
            : "What this integration needs, and which of it this deployment has."
        }
      >
        <div className="flex flex-col gap-3">
          {keyNotice && (
            <p
              role="note"
              className="m-0 rounded-[3px] border border-neutral-300 bg-neutral-50 px-3 py-2 font-body text-[12px] text-neutral-700"
            >
              {keyNotice.text}{" "}
              <a
                href={SECRETS_KEY_SETUP_URL}
                target="_blank"
                rel="noreferrer"
                className="text-neutral-900 underline"
              >
                Open SETUP.md
              </a>
            </p>
          )}
          {integration.fields.length === 0 && (
            <p className="m-0 font-body text-[12px] text-neutral-600">
              This integration needs no values.
            </p>
          )}
          {integration.fields.map((field) => {
            const clearing = clearedSecrets.includes(field.key);
            const secretLocked = field.secret && !state.secretsKeyAvailable;
            const control =
              field.format === "multiline" ? (
                <Textarea
                  value={values[field.key] ?? ""}
                  disabled={!writable || busy !== null || secretLocked || clearing}
                  monospace
                  onChange={(event) => typeInto(field.key, event.target.value)}
                />
              ) : (
                <Input
                  type={field.secret ? "password" : field.format === "url" ? "url" : "text"}
                  inputMode={field.format === "integer" ? "numeric" : undefined}
                  autoComplete={field.secret ? "new-password" : "off"}
                  value={values[field.key] ?? ""}
                  placeholder={
                    field.secret && field.storedSecretSet && !clearing
                      ? "A value is stored"
                      : undefined
                  }
                  disabled={!writable || busy !== null || secretLocked || clearing}
                  monospace
                  onChange={(event) => typeInto(field.key, event.target.value)}
                />
              );
            return (
              <div key={field.key} className="flex flex-col gap-1">
                <Field
                  label={field.label}
                  required={!field.optional}
                  hint={fieldHint(field, state, clearing)}
                  error={missing.includes(field.label) ? "This one is required." : undefined}
                >
                  {control}
                </Field>
                {field.secret && field.storedSecretSet && writable && (
                  <Button
                    variant="text"
                    className="self-start font-body text-[11px] text-neutral-700 underline"
                    disabled={busy !== null}
                    onClick={() => {
                      setDirty(true);
                      setClearedSecrets((current) =>
                        clearing
                          ? current.filter((key) => key !== field.key)
                          : [...current, field.key],
                      );
                    }}
                  >
                    {clearing ? "Keep the stored value" : "Erase the stored value on save"}
                  </Button>
                )}
              </div>
            );
          })}
        </div>

        {writable && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                loading={busy === "save"}
                disabled={busy !== null || keyNotice?.blocksSave === true}
                title={keyNotice?.blocksSave ? keyNotice.text : undefined}
                onClick={save}
              >
                Save and test
              </Button>
              <Button
                variant="secondary"
                loading={busy === "test"}
                disabled={busy !== null}
                onClick={test}
              >
                Test what is in use
              </Button>
            </div>
            {/* A spinner on a button is the whole story of a wait that can last
                twenty seconds, and a screen reader is told nothing at all. This
                says how long the wait can be, once, when it starts. */}
            {(busy === "save" || busy === "test") && (
              <p role="status" aria-live="polite" className="m-0 font-body text-[12px] text-neutral-600">
                {waitingOnProviderLine(integration)}
              </p>
            )}
          </div>
        )}
      </Section>

      <Section
        title="Where the values come from"
        description="An integration reads either this deployment's environment variables or the values stored here, never both. Stored values can be filled in and tested while the environment is still the one in use."
      >
        <div className="flex flex-col gap-2 sm:flex-row">
          <div
            className={`flex-1 rounded-[3px] border px-3 py-2 ${
              state.source === "environment"
                ? "border-mariner-200 bg-mariner-100"
                : "border-neutral-200 bg-app-bg"
            }`}
          >
            <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-700">
              Environment variables{sourceInUse(state, "environment") ? " · in use" : ""}
            </div>
            <div className="mt-1 flex flex-col gap-[2px] font-body text-[11px] text-neutral-600">
              {integration.fields.map((field) => (
                <span key={field.key} className="font-mono text-[10px]">
                  {field.env}: {field.envSet ? "set" : "not set"}
                </span>
              ))}
              {integration.fields.length === 0 && <span>No variables to set.</span>}
            </div>
            {writable && state.source !== "environment" && (
              <Button
                variant="secondary"
                size="sm"
                className="mt-2"
                disabled={busy !== null || environmentRefusal !== null}
                title={environmentRefusal ?? undefined}
                loading={busy === "source"}
                onClick={() => switchSource("environment")}
              >
                Use the environment
              </Button>
            )}
            {writable && state.source !== "environment" && environmentRefusal && (
              <p className="m-0 mt-1 font-body text-[11px] text-neutral-500">
                {environmentRefusal}
              </p>
            )}
          </div>
          <div
            className={`flex-1 rounded-[3px] border px-3 py-2 ${
              state.source === "stored"
                ? "border-mariner-200 bg-mariner-100"
                : "border-neutral-200 bg-app-bg"
            }`}
          >
            <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-700">
              Stored here{sourceInUse(state, "stored") ? " · in use" : ""}
            </div>
            <div className="mt-1 font-body text-[11px] text-neutral-600">
              {stored
                ? `Saved ${state.stored.latestVersion} ${state.stored.latestVersion === 1 ? "time" : "times"}${
                    state.stored.activeVersion === null
                      ? ", none of it in use yet"
                      : `, version ${state.stored.activeVersion} is the one that passed its test`
                  }.`
                : "Nothing is stored here."}
            </div>
            {writable && state.source !== "stored" && (
              <Button
                variant="secondary"
                size="sm"
                className="mt-2"
                disabled={busy !== null || storedRefusal !== null}
                title={storedRefusal ?? undefined}
                loading={busy === "source"}
                onClick={() => switchSource("stored")}
              >
                Use the stored values
              </Button>
            )}
            {writable && state.source !== "stored" && storedRefusal && (
              <p className="m-0 mt-1 font-body text-[11px] text-neutral-500">{storedRefusal}</p>
            )}
          </div>
        </div>
      </Section>

      {writable && (
        <Section
          title="Availability"
          description="The kill switch works whichever source the values come from, and changes no value."
        >
          {availabilityNote ? (
            <p className="m-0 font-body text-[12px] text-neutral-700">{availabilityNote}</p>
          ) : (
            <Switch
              checked={state.enabled}
              disabled={busy !== null}
              aria-label={`Let workflows use ${integration.name}`}
              onCheckedChange={(next) =>
                next ? setEnabled(true) : void previewChange({ preview: "disable" }, "disable")
              }
            >
              <span className="font-body text-[12px] text-neutral-800">
                {state.enabled ? "Workflows may use it" : "Turned off"}
              </span>
            </Switch>
          )}

          {stored ? (
            <div className="flex flex-col gap-1 border-t border-neutral-200 pt-3">
              <Button
                variant="danger"
                className="self-start"
                disabled={busy !== null}
                onClick={() => void previewChange({ preview: "disconnect" }, "disconnect")}
              >
                Disconnect
              </Button>
              <p className="m-0 font-body text-[11px] text-neutral-500">
                {disconnectConsequence(integration)[1]}
              </p>
            </div>
          ) : (
            <p className="m-0 border-t border-neutral-200 pt-3 font-body text-[11px] text-neutral-500">
              {nothingToDisconnectLine(integration)}
            </p>
          )}
        </Section>
      )}

      {confirming === "disable" && (
        <ConfirmDialog
          title={`Turn ${integration.name} off?`}
          lines={
            busy === "impact"
              ? [READING_IMPACT_LINE]
              : [
                  ...integrationImpactLines(integration, impact, "disable"),
                  ...disableConsequence(integration),
                ]
          }
          confirmLabel={
            busy === "impact" ? "Reading impact" : integrationImpactConfirmLabel(impact, "disable")
          }
          busy={busy === "impact" || busy === "enabled"}
          onConfirm={() => setEnabled(false)}
          onClose={closeConfirmation}
        />
      )}

      {confirming === "source" && (
        <ConfirmDialog
          title={
            pendingSource === "environment"
              ? `Switch ${integration.name} to the environment?`
              : `Switch ${integration.name} to the stored values?`
          }
          lines={
            busy === "impact"
              ? [READING_IMPACT_LINE]
              : integrationImpactLines(integration, impact, "source")
          }
          confirmLabel={
            busy === "impact" ? "Reading impact" : integrationImpactConfirmLabel(impact, "source")
          }
          busy={busy === "impact" || busy === "source"}
          onConfirm={() => pendingSource && performSourceSwitch(pendingSource)}
          onClose={closeConfirmation}
        />
      )}

      {confirming === "save" && (
        <ConfirmDialog
          title={`Save ${integration.name}'s new connection?`}
          lines={
            busy === "impact"
              ? [READING_IMPACT_LINE]
              : integrationImpactLines(integration, impact, "save")
          }
          confirmLabel={
            busy === "impact"
              ? "Reading impact"
              : integrationImpactConfirmLabel(impact, "save")
          }
          busy={busy === "impact" || busy === "save"}
          onConfirm={() => pendingSave && performSave(pendingSave)}
          onClose={closeConfirmation}
        />
      )}

      {confirming === "disconnect" && (
        <ConfirmDialog
          title={`Disconnect ${integration.name}?`}
          lines={
            busy === "impact"
              ? [READING_IMPACT_LINE]
              : [
                  ...integrationImpactLines(integration, impact, "disconnect"),
                  ...disconnectConsequence(integration),
                ]
          }
          confirmLabel={
            busy === "impact"
              ? "Reading impact"
              : integrationImpactConfirmLabel(impact, "disconnect")
          }
          busy={busy === "impact" || busy === "disconnect"}
          onConfirm={disconnect}
          onClose={closeConfirmation}
        />
      )}
    </div>
  );
}

export function UnknownIntegrationScreen({ id }: { id: string }) {
  return (
    <div className="flex flex-col gap-3 px-4 lg:px-6 pt-5 pb-8 max-w-[640px]">
      <BackToIntegrations />
      <h2 className="m-0 font-display text-2xl font-medium leading-[1.2] text-neutral-900">
        No integration under that name
      </h2>
      <p className="m-0 font-body text-[13px] text-neutral-600">
        This build ships no integration with the id <code className="font-mono">{id}</code>.
        It may have been removed from the build, in which case anything stored for
        it is ignored and workflows that used its blocks say so on the canvas.
      </p>
    </div>
  );
}
