/**
 * Canonical shape of a prompt slot name, shared by prompt composition, the
 * workflow definition schema and the dashboard's slot editor so a name accepted
 * on one side can never be refused on another.
 */
export const PROMPT_SLOT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
