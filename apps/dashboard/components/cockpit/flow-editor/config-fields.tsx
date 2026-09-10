"use client";

import configFieldCompatibility from "./blocks/shared";
import scheduleHistoryCompatibility from "./blocks/schedule-history";

export { ConfigFields } from "./blocks/index";
export { ConfigField, inputCls } from "./blocks/shared";
export { WebhookDeliveriesSection, WebhookEndpointSection, describeRotationWindow, formatWebhookInstant } from "./blocks/webhook-endpoint";
export { ScheduleNextRunsSection } from "./blocks/schedule-preview";

export const {
  monoTextareaCls,
  textareaCls,
  triggerRateWindowResetAt,
} = configFieldCompatibility;
export const { ScheduleOccurrenceHistorySection } = scheduleHistoryCompatibility;
