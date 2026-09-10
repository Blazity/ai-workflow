"use client";

import { useEffect, useRef, useState } from "react";
import type { FlowNodeDef } from "@/lib/flows";
import type { ScheduleOverlapPolicy, SchedulePreset, SchedulePreviewRequest, ScheduleWeekday } from "@shared/contracts";
import { apiClient } from "@/lib/api/client";
import { Listbox } from "@/components/cockpit/listbox";
import { ConfigField, ConfigNote, NumberField, TextArea, TextInput, TriggerRateLimitFields, str, webhookActionButtonCls } from "./shared";
import { SCHEDULE_EVERY_N_HOURS_STEPS, SCHEDULE_EVERY_N_MINUTES_STEPS, SCHEDULE_OVERLAP_POLICY_OPTIONS, SCHEDULE_PRESET_KIND_OPTIONS, ScheduleWeekdayToggles, scheduleModeToggleCls } from "./schedule-preview";
import { ScheduleStatusPanel } from "./schedule-history";
import type { ConfigChange } from "./types";
import type { SchedulePreviewState } from "./schedule-preview";

const SCHEDULE_INTERVAL_PRESET_TIMEZONE = "UTC";

/**
 * Kinds the schedule preset builder can produce. Mirrors
 * apps/worker/src/schedule-trigger/occurrence.ts SchedulePreset["kind"] exactly.
 * The presets are sugar: they only ever reach the deployed schedule by
 * compiling to a cron expression through the worker's compileSchedulePreset,
 * the same evaluator a hand-written expression goes through, so a preset can
 * never mean something the raw expression field would not.
 */
type SchedulePresetKind = "every-n-minutes" | "every-n-hours" | "daily" | "weekly";

/**
 * The preset builder plus its debounced live preview, extracted out of
 * ScheduleTriggerFields into its own unit the way WebhookEndpointPanel holds
 * the webhook trigger's own server-owned half. Owns everything the builder
 * needs: which mode and preset fields are selected, the remembered timezone
 * that survives an interval preset's override (see the block comment above
 * reconcileTimezoneForPreset), and the preview fetch, and renders the
 * "Schedule" and "Timezone" fields plus the embedded ScheduleStatusPanel.
 */
function ScheduleCronBuilder({
  node,
  canEdit,
  definitionId,
  onChange,
  onPreviewChange,
}: {
  node: FlowNodeDef;
  canEdit: boolean;
  definitionId: number | undefined;
  onChange: ConfigChange;
  /** Reports the latest preview state upward so a sibling field (catch-up
   *  grace) can offer suggestedGraceMinutes as a suggestion, without lifting
   *  the fetch itself out of this component. */
  onPreviewChange?: (preview: SchedulePreviewState) => void;
}) {
  const cron = str(node.params.cron);
  const timezone = str(node.params.timezone) || SCHEDULE_INTERVAL_PRESET_TIMEZONE;

  const [builderMode, setBuilderMode] = useState<"custom" | "preset">("custom");
  const [presetKind, setPresetKind] = useState<SchedulePresetKind>("every-n-minutes");
  const [presetMinutes, setPresetMinutes] = useState<number>(15);
  const [presetHours, setPresetHours] = useState<number>(1);
  const [presetHour, setPresetHour] = useState<number>(9);
  const [presetMinute, setPresetMinute] = useState<number>(0);
  const [presetWeekdays, setPresetWeekdays] = useState<ScheduleWeekday[]>([1]);

  // A1: the timezone the operator last typed or confirmed themselves, kept
  // beside the authored one rather than instead of it. An interval preset's
  // Apply overwrites params.timezone with UTC (see presetIgnoresTimezone
  // below) without ever touching this, which is what makes it possible to
  // give the zone back when the operator later switches to a clock-anchored
  // preset. Initialised from whatever is authored at mount: at that instant
  // there is no evidence it is a leftover override, so treating it as the
  // operator's own choice is correct, not a guess.
  const [rememberedTimezone, setRememberedTimezone] = useState<string | null>(
    () => str(node.params.timezone) || SCHEDULE_INTERVAL_PRESET_TIMEZONE,
  );
  const [timezoneNeedsConfirmation, setTimezoneNeedsConfirmation] = useState(false);
  const [timezoneRestoredNotice, setTimezoneRestoredNotice] = useState<string | null>(null);

  let presetWire: SchedulePreset;
  switch (presetKind) {
    case "every-n-minutes":
      presetWire = { kind: "every-n-minutes", minutes: presetMinutes };
      break;
    case "every-n-hours":
      presetWire = { kind: "every-n-hours", hours: presetHours };
      break;
    case "daily":
      presetWire = { kind: "daily", hour: presetHour, minute: presetMinute };
      break;
    case "weekly":
      presetWire = { kind: "weekly", weekdays: presetWeekdays, hour: presetHour, minute: presetMinute };
      break;
  }

  const previewRequest: SchedulePreviewRequest =
    builderMode === "preset"
      ? { source: "preset", preset: presetWire, timezone }
      : { source: "cron", cron, timezone };
  const requestKey = JSON.stringify(previewRequest);

  // Mirrors occurrence.ts's own rule (compileSchedulePreset / INTERVAL_PRESET_TIMEZONE):
  // "every N minutes" and "every N hours" below a full day have no clock
  // meaning, an interval is the same interval in any zone, so the worker
  // always compiles them in UTC regardless of the timezone field. Every 24
  // hours is daily at midnight, a clock-anchored preset, and keeps the zone
  // below like "daily" and "weekly" do.
  function ignoresTimezone(kind: SchedulePresetKind, hours: number): boolean {
    return kind === "every-n-minutes" || (kind === "every-n-hours" && hours !== 24);
  }
  const presetIgnoresTimezone = builderMode === "preset" && ignoresTimezone(presetKind, presetHours);

  /**
   * A1's fix: switching TO a clock-anchored preset (kind or step change) must
   * not silently keep whatever an earlier interval preset's Apply forced the
   * timezone field to. Three outcomes:
   *   - moving to (or staying on) an interval kind: nothing to reconcile, and
   *     any pending confirmation is stale, drop it;
   *   - the authored zone already matches what is remembered: nothing was
   *     overridden, leave it alone;
   *   - it does not match: something overwrote it (only Apply-for-an-interval-
   *     preset ever does), so restore the remembered zone and say so, or, if
   *     there is nothing remembered to restore (only reachable if this
   *     component remounted between the override and this switch, losing the
   *     in-memory value), blank the field and refuse to apply until the
   *     operator states one explicitly rather than silently keep UTC.
   */
  function reconcileTimezoneForPreset(kind: SchedulePresetKind, hours: number) {
    if (ignoresTimezone(kind, hours)) {
      setTimezoneNeedsConfirmation(false);
      setTimezoneRestoredNotice(null);
      return;
    }
    const authored = str(node.params.timezone) || SCHEDULE_INTERVAL_PRESET_TIMEZONE;
    if (authored === rememberedTimezone) {
      setTimezoneRestoredNotice(null);
      return;
    }
    if (rememberedTimezone === null) {
      setTimezoneNeedsConfirmation(true);
      setTimezoneRestoredNotice(null);
      return;
    }
    onChange("params.timezone", rememberedTimezone);
    setTimezoneNeedsConfirmation(false);
    setTimezoneRestoredNotice(rememberedTimezone);
  }

  function writeTimezone(value: string) {
    const trimmed = value.trim();
    const next = trimmed === "" ? SCHEDULE_INTERVAL_PRESET_TIMEZONE : value;
    onChange("params.timezone", next);
    setRememberedTimezone(next);
    setTimezoneNeedsConfirmation(false);
    setTimezoneRestoredNotice(null);
  }

  const [preview, setPreview] = useState<SchedulePreviewState>({ status: "idle" });
  const previewAbortRef = useRef<AbortController | null>(null);
  const previewFirstRunRef = useRef(true);

  useEffect(
    () => () => {
      previewAbortRef.current?.abort();
    },
    [],
  );

  useEffect(() => {
    onPreviewChange?.(preview);
  }, [preview, onPreviewChange]);

  // Debounced like the workflow validator (5s): fires immediately on the first
  // render of this node so the panel is not blank on open, then waits out a
  // quiet period on every later change instead of firing per keystroke.
  useEffect(() => {
    if (definitionId === undefined) {
      setPreview({ status: "idle" });
      return;
    }
    const resolvedDefinitionId = definitionId;
    const delayMs = previewFirstRunRef.current ? 0 : 5_000;
    previewFirstRunRef.current = false;

    async function runPreview() {
      previewAbortRef.current?.abort();
      const controller = new AbortController();
      previewAbortRef.current = controller;
      setPreview({ status: "loading" });
      try {
        const response = await apiClient.triggers.schedulePreview(
          resolvedDefinitionId,
          node.id,
          previewRequest,
          { cache: "no-store", signal: controller.signal },
        );
        if (!response.ok) throw new Error(response.errorMessage);
        const payload = response.data;
        if (controller.signal.aborted) return;
        if (payload.ok) {
          setPreview({
            status: "ok",
            cron: payload.cron,
            timezone: payload.timezone,
            runs: payload.runs,
            requestKey,
            suggestedGraceMinutes: payload.suggestedGraceMinutes,
          });
        } else {
          setPreview({ status: "error", message: payload.problem.message });
        }
      } catch (caught) {
        if (controller.signal.aborted) return;
        setPreview({
          status: "error",
          message: caught instanceof Error ? caught.message : "Unable to compute the preview.",
        });
      }
    }

    const timer = setTimeout(() => void runPreview(), delayMs);
    return () => clearTimeout(timer);
  }, [definitionId, node.id, requestKey]);

  return (
    <>
      <ConfigField
        label="Schedule"
        action={
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={!canEdit}
              onClick={() => setBuilderMode("custom")}
              className={builderMode === "custom" ? webhookActionButtonCls : scheduleModeToggleCls}
            >
              Custom
            </button>
            <button
              type="button"
              disabled={!canEdit}
              onClick={() => setBuilderMode("preset")}
              className={builderMode === "preset" ? webhookActionButtonCls : scheduleModeToggleCls}
            >
              Preset
            </button>
          </div>
        }
      >
        {builderMode === "custom" ? (
          <TextInput
            value={cron}
            disabled={!canEdit}
            placeholder="0 9 * * *"
            onChange={(v) => onChange("params.cron", v)}
          />
        ) : (
          <div className="flex flex-col gap-2">
            <Listbox
              options={SCHEDULE_PRESET_KIND_OPTIONS}
              value={presetKind}
              disabled={!canEdit}
              ariaLabel="Preset kind"
              onChange={(v) => {
                const kind = v as SchedulePresetKind;
                setPresetKind(kind);
                reconcileTimezoneForPreset(kind, presetHours);
              }}
            />
            {presetKind === "every-n-minutes" && (
              <Listbox
                options={SCHEDULE_EVERY_N_MINUTES_STEPS.map((m) => ({
                  value: String(m),
                  label: `Every ${m} minutes`,
                }))}
                value={String(presetMinutes)}
                disabled={!canEdit}
                ariaLabel="Minute step"
                onChange={(v) => setPresetMinutes(Number(v))}
              />
            )}
            {presetKind === "every-n-hours" && (
              <Listbox
                options={SCHEDULE_EVERY_N_HOURS_STEPS.map((h) => ({
                  value: String(h),
                  label: `Every ${h} hour${h === 1 ? "" : "s"}`,
                }))}
                value={String(presetHours)}
                disabled={!canEdit}
                ariaLabel="Hour step"
                onChange={(v) => {
                  const hours = Number(v);
                  setPresetHours(hours);
                  reconcileTimezoneForPreset(presetKind, hours);
                }}
              />
            )}
            {(presetKind === "daily" || presetKind === "weekly") && (
              <div className="flex items-center gap-1.5">
                <NumberField
                  value={presetHour}
                  min={0}
                  max={23}
                  disabled={!canEdit}
                  onChange={(v) => setPresetHour(v ?? 0)}
                />
                <span className="font-mono text-[10px] text-neutral-600">:</span>
                <NumberField
                  value={presetMinute}
                  min={0}
                  max={59}
                  disabled={!canEdit}
                  onChange={(v) => setPresetMinute(v ?? 0)}
                />
              </div>
            )}
            {presetKind === "weekly" && (
              <ScheduleWeekdayToggles
                value={presetWeekdays}
                disabled={!canEdit}
                onChange={setPresetWeekdays}
              />
            )}
            {presetIgnoresTimezone && (
              <div className="font-body text-[11px] leading-[1.4] text-neutral-600">
                This preset fires at a fixed interval and does not observe daylight
                saving, so the timezone below does not apply to it. Applying it saves
                the schedule in {SCHEDULE_INTERVAL_PRESET_TIMEZONE} no matter what the
                timezone field says.
              </div>
            )}
            <button
              type="button"
              disabled={
                !canEdit ||
                preview.status !== "ok" ||
                preview.requestKey !== requestKey ||
                timezoneNeedsConfirmation
              }
              onClick={() => {
                if (preview.status === "ok") {
                  // Both fields, not just the cron: what is saved is what runs, and
                  // an interval preset's compiled timezone (UTC) can differ from
                  // whatever is currently typed in the timezone field below.
                  onChange("params.cron", preview.cron);
                  onChange("params.timezone", preview.timezone);
                  // Only a clock-anchored Apply updates the remembered zone: an
                  // interval preset's UTC is occurrence.ts's override, never the
                  // operator's own choice, and must not overwrite it (A1).
                  if (!presetIgnoresTimezone) setRememberedTimezone(preview.timezone);
                  setBuilderMode("custom");
                }
              }}
              className={webhookActionButtonCls}
            >
              Apply preset
            </button>
          </div>
        )}
      </ConfigField>
      <ConfigNote>
        Presets compile to a cron expression through the worker, the only place a
        schedule is ever evaluated, so a preset can never mean something the raw
        expression above would not. Switch to Custom to type an expression directly
        for anything a preset cannot express.
      </ConfigNote>
      <ConfigField label="Timezone">
        <TextInput
          value={timezoneNeedsConfirmation ? "" : timezone}
          disabled={!canEdit}
          placeholder="UTC"
          onChange={writeTimezone}
        />
      </ConfigField>
      {timezoneRestoredNotice !== null && (
        <ConfigNote>
          Restored your previous timezone ({timezoneRestoredNotice}): the preset you
          just left ignores it and saves {SCHEDULE_INTERVAL_PRESET_TIMEZONE} instead.
        </ConfigNote>
      )}
      {timezoneNeedsConfirmation && (
        <div role="alert" className="py-2.5 px-[14px] border-b border-neutral-200 font-body text-xs leading-[1.5] text-red-700">
          Your previous timezone could not be carried over. Choose one before applying
          this preset.
        </div>
      )}
      <ConfigNote>
        An IANA timezone name, for example Europe/Warsaw. Never left blank: without
        one the schedule would silently run in the host machine's timezone instead.
        {presetIgnoresTimezone &&
          " The preset selected above ignores this field, see the note next to it."}
      </ConfigNote>
      <ScheduleStatusPanel
        definitionId={definitionId}
        nodeId={node.id}
        canEdit={canEdit}
        draftCron={cron}
        draftTimezone={timezone}
        preview={preview}
        requestKey={requestKey}
      />
    </>
  );
}

export function ScheduleTriggerFields({
  node,
  canEdit,
  definitionId,
  onChange,
}: {
  node: FlowNodeDef;
  canEdit: boolean;
  definitionId: number | undefined;
  onChange: ConfigChange;
}) {
  const overlapPolicy: ScheduleOverlapPolicy = SCHEDULE_OVERLAP_POLICY_OPTIONS.some(
    (option) => option.value === node.params.overlapPolicy,
  )
    ? (node.params.overlapPolicy as ScheduleOverlapPolicy)
    : "skip";

  // A suggestion only (item G): suggestedGraceMinutes comes from the same
  // debounced preview ScheduleCronBuilder already fetches for the cron
  // expression above, reported up rather than fetched a second time here.
  // It is never written to params.catchUpGraceMinutes on its own, only when
  // the operator clicks "Use suggestion", so an existing authored value is
  // never silently overwritten by a schedule edit.
  const [schedulePreview, setSchedulePreview] = useState<SchedulePreviewState>({
    status: "idle",
  });
  const suggestedGraceMinutes =
    schedulePreview.status === "ok" ? schedulePreview.suggestedGraceMinutes : null;
  const currentGraceMinutes =
    typeof node.params.catchUpGraceMinutes === "number" ? node.params.catchUpGraceMinutes : null;

  return (
    <>
      <ConfigField label="Task title">
        <TextInput
          value={str(node.params.taskTitle)}
          disabled={!canEdit}
          placeholder="Nightly dependency check"
          onChange={(v) => onChange("params.taskTitle", v)}
        />
      </ConfigField>
      <ConfigField label="Task description">
        <TextArea
          value={str(node.params.taskDescription)}
          disabled={!canEdit}
          placeholder="What should the agent do each time this fires?"
          onChange={(v) => onChange("params.taskDescription", v)}
        />
      </ConfigField>
      <ConfigNote>
        A scheduled run has no ticket, so the task title and description above are
        what it actually works on. Each occurrence opens its own pull request on its
        own branch: sharing one branch across occurrences would let a reviewer's push
        to it kill every later occurrence, so expect one pull request per occurrence,
        for example one a day on a daily schedule.
      </ConfigNote>
      <ScheduleCronBuilder
        node={node}
        canEdit={canEdit}
        definitionId={definitionId}
        onChange={onChange}
        onPreviewChange={setSchedulePreview}
      />
      <ConfigField label="If the previous run is still going">
        <Listbox
          options={SCHEDULE_OVERLAP_POLICY_OPTIONS}
          value={overlapPolicy}
          disabled={!canEdit}
          ariaLabel="Overlap policy"
          onChange={(v) => onChange("params.overlapPolicy", v)}
        />
      </ConfigField>
      {/* "two" is MAX_IN_FLIGHT_OCCURRENCES_PER_SCHEDULE in the worker's
          dispatch-schedule-trigger.ts, stated here as a word because the worker
          and the dashboard are different packages. It is the cap on THIS
          schedule, not the worker-wide agent pool: naming the pool here once
          described a limit allow does not have. Change one and change both. */}
      <ConfigNote>
        Skip: this occurrence does not run, and the reason is recorded. It will not
        run and will not be replayed. Queue: at most one occurrence waits, the newest
        one; an older waiting occurrence is settled as replaced, not run, and not
        replayed either. Allow: occurrences run alongside each other, up to two runs
        of this schedule at a time, so a run that outruns its own period does not cost
        you the next occurrence. A further occurrence is skipped as an overlap while
        those two are still going, which is what stops one schedule filling the
        worker with its own runs.
      </ConfigNote>
      <ConfigField label="Catch-up grace (minutes)">
        <div className="flex items-center gap-1.5">
          <NumberField
            value={node.params.catchUpGraceMinutes}
            min={5}
            max={1440}
            disabled={!canEdit}
            onChange={(v) => onChange("params.catchUpGraceMinutes", v)}
          />
          {canEdit &&
            suggestedGraceMinutes !== null &&
            suggestedGraceMinutes !== currentGraceMinutes && (
              <button
                type="button"
                onClick={() => onChange("params.catchUpGraceMinutes", suggestedGraceMinutes)}
                className={webhookActionButtonCls}
              >
                Use suggested {suggestedGraceMinutes}
              </button>
            )}
        </div>
      </ConfigField>
      <ConfigNote>
        How late a missed occurrence may still be and be worth running, for example
        after a deploy was broken for a while. Five minutes is the floor: the
        scheduler only checks once a minute, so a smaller tolerance means one slow
        tick alone can lose an occurrence.
        {suggestedGraceMinutes !== null &&
          suggestedGraceMinutes !== currentGraceMinutes &&
          ` Based on the schedule above, ${suggestedGraceMinutes} minutes would cover the typical gap between occurrences; this is only a suggestion, your own value above is kept until you choose to use it.`}
      </ConfigNote>
      <TriggerRateLimitFields
        node={node}
        canEdit={canEdit}
        definitionId={definitionId}
        schedule
        onChange={onChange}
      />
    </>
  );
}
