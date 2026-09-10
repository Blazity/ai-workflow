// THIS FILE IS GENERATED. DO NOT EDIT.
// Run pnpm run gen:blocks to update.

import type {
  WorkflowBlockAdditionalInputContract,
  WorkflowBlockGroup,
  WorkflowBlockInputContract,
  WorkflowParamValue,
} from "./block-catalog-types";

export type BlockCategory = "trigger" | "action" | "control";

export interface BlockTypeSpec {
  category: BlockCategory;
  ports: string[];
  allowsFailurePort: boolean;
}

export type BlockExecutionKind = "map" | "inline" | "graph";

export interface BlockUiHints {
  group: WorkflowBlockGroup;
  label: string;
  description: string;
  glyph: string;
  color: string;
  softColor: string;
}

export interface BlockCatalogEntry {
  contract: BlockTypeSpec;
  ui: BlockUiHints;
  defaults: Record<string, WorkflowParamValue>;
  inputs: Record<string, WorkflowBlockInputContract>;
  additionalInputs: WorkflowBlockAdditionalInputContract[];
  execution: BlockExecutionKind;
}

export interface BlockManifest extends Omit<BlockCatalogEntry, "additionalInputs"> {
  type: WorkflowBlockType;
  paramsSchema: unknown;
  additionalInputs?: WorkflowBlockAdditionalInputContract[];
}

export type WorkflowBlockType =
  | "arthur_injection_check"
  | "branch"
  | "call_llm"
  | "complete_pr_check"
  | "create_pr_check"
  | "fetch_pr_context"
  | "finalize_workspace"
  | "fix_agent"
  | "generic_agent"
  | "human_question"
  | "implementation_agent"
  | "investigate"
  | "leak_review"
  | "loop"
  | "open_pr"
  | "planning_agent"
  | "post_pr_comment"
  | "post_pr_review"
  | "post_ticket_comment"
  | "prepare_workspace"
  | "review_agent"
  | "run_checks"
  | "run_pre_pr_checks"
  | "run_scripts"
  | "send_plan_approval"
  | "send_slack_message"
  | "terminate"
  | "transform"
  | "trigger_plan_approved"
  | "trigger_pr_checks_failed"
  | "trigger_pr_created"
  | "trigger_pr_merged"
  | "trigger_pr_ready"
  | "trigger_pr_review"
  | "trigger_pr_updated"
  | "trigger_schedule"
  | "trigger_ticket_ai"
  | "trigger_webhook"
  | "update_ticket_status";

export const BLOCK_CATALOG: Record<WorkflowBlockType, BlockCatalogEntry> = {
  arthur_injection_check: {
    contract: {"category":"action","ports":["out"],"allowsFailurePort":true},
    ui: {"group":"arthur","label":"Prompt injection check","description":"Scans untrusted content with the optional Arthur Engine integration.","glyph":"◬","color":"#8b6f8f","softColor":"#F3F0F4"},
    defaults: {},
    inputs: {
      "content": {
        "required": false,
        "schema": {
          "type": "string"
        }
      }
    },
    additionalInputs: [],
    execution: "map",
  },
  branch: {
    contract: {"category":"control","ports":["true","false"],"allowsFailurePort":false},
    ui: {"group":"control","label":"Branch","description":"Chooses one of two paths using the restricted condition language.","glyph":"⋔","color":"#35823f","softColor":"#E9F3EA"},
    defaults: {
      "condition": ""
    },
    inputs: {},
    additionalInputs: [],
    execution: "graph",
  },
  call_llm: {
    contract: {"category":"action","ports":["out"],"allowsFailurePort":true},
    ui: {"group":"utility","label":"Call LLM","description":"Runs a focused non-agent LLM transform with an optional output schema.","glyph":"λ","color":"#64748B","softColor":"#EEF1F5"},
    defaults: {
      "prompt": ""
    },
    inputs: {
      "prompt": {
        "required": false,
        "schema": {
          "type": "string"
        }
      },
      "system": {
        "required": false,
        "schema": {
          "type": "string"
        }
      }
    },
    additionalInputs: [],
    execution: "map",
  },
  complete_pr_check: {
    contract: {"category":"action","ports":["out"],"allowsFailurePort":false},
    ui: {"group":"vcs","label":"Complete PR check","description":"Completes a check created by this workflow run.","glyph":"●","color":"#3C43E7","softColor":"#ECECFD"},
    defaults: {
      "conclusion": "success",
      "details": "",
      "refreshHead": false
    },
    inputs: {
      "check": {
        "required": true,
        "schema": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string"
            },
            "headSha": {
              "type": "string"
            },
            "name": {
              "type": "string"
            }
          },
          "required": [
            "id",
            "headSha",
            "name"
          ],
          "additionalProperties": false
        }
      },
      "details": {
        "required": false,
        "schema": {
          "type": "string"
        }
      }
    },
    additionalInputs: [],
    execution: "map",
  },
  create_pr_check: {
    contract: {"category":"action","ports":["out"],"allowsFailurePort":false},
    ui: {"group":"vcs","label":"Create PR check","description":"Creates a pending check for the exact pull request commit being reviewed.","glyph":"◌","color":"#3C43E7","softColor":"#ECECFD"},
    defaults: {
      "checkName": "AI Workflow / Review"
    },
    inputs: {},
    additionalInputs: [],
    execution: "map",
  },
  fetch_pr_context: {
    contract: {"category":"action","ports":["out"],"allowsFailurePort":true},
    ui: {"group":"vcs","label":"Fetch PR context","description":"Loads review comments, check results, and conflict state for the PR or MR.","glyph":"⇊","color":"#3C43E7","softColor":"#ECECFD"},
    defaults: {},
    inputs: {},
    additionalInputs: [],
    execution: "map",
  },
  finalize_workspace: {
    contract: {"category":"action","ports":["out"],"allowsFailurePort":true},
    ui: {"group":"workspace","label":"Finalize workspace","description":"Preflights and publishes committed workspace changes.","glyph":"⇉","color":"#0f7f8b","softColor":"#E7F2F3"},
    defaults: {},
    inputs: {},
    additionalInputs: [
      {
        "keyPattern": "^checks\\.[A-Za-z0-9_-]+$",
        "schema": {
          "type": "string"
        }
      }
    ],
    execution: "map",
  },
  fix_agent: {
    contract: {"category":"action","ports":["out"],"allowsFailurePort":true},
    ui: {"group":"agents","label":"Fix agent","description":"Applies review, CI, or conflict remediation in a managed workspace.","glyph":"✚","color":"#7C3AED","softColor":"#F2EBFD"},
    defaults: {
      "maxMinutes": 25
    },
    inputs: {
      "reviewFeedback": {
        "required": false,
        "schema": {
          "type": "object",
          "properties": {
            "state": {
              "type": "string",
              "enum": [
                "changes_requested",
                "commented"
              ]
            },
            "author": {
              "type": "string"
            },
            "body": {
              "type": "string"
            }
          },
          "required": [
            "state",
            "author",
            "body"
          ],
          "additionalProperties": false
        }
      },
      "reviewResults": {
        "required": false,
        "schema": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "decision": {
                "type": "string",
                "enum": [
                  "approve",
                  "request_changes"
                ]
              },
              "findings": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "file": {
                      "type": "string"
                    },
                    "description": {
                      "type": "string"
                    },
                    "severity": {
                      "type": "string",
                      "enum": [
                        "Blocker",
                        "High",
                        "Medium",
                        "Nit"
                      ]
                    },
                    "startLine": {
                      "type": "number"
                    },
                    "endLine": {
                      "type": "number"
                    },
                    "repo": {
                      "type": "string"
                    }
                  },
                  "required": [
                    "file",
                    "description",
                    "severity"
                  ],
                  "additionalProperties": true
                }
              },
              "feedback": {
                "type": "string"
              }
            },
            "required": [
              "decision",
              "findings"
            ],
            "additionalProperties": true
          }
        }
      }
    },
    additionalInputs: [],
    execution: "map",
  },
  generic_agent: {
    contract: {"category":"action","ports":["out"],"allowsFailurePort":true},
    ui: {"group":"agents","label":"Generic agent","description":"Runs a configurable agent prompt with an optional declared output schema.","glyph":"❖","color":"#7C3AED","softColor":"#F2EBFD"},
    defaults: {
      "prompt": "",
      "workspaceMode": "none"
    },
    inputs: {
      "prompt": {
        "required": false,
        "schema": {
          "type": "string"
        }
      }
    },
    additionalInputs: [],
    execution: "map",
  },
  human_question: {
    contract: {"category":"action","ports":["out"],"allowsFailurePort":true},
    ui: {"group":"human","label":"Human question","description":"Parks execution until the ticket owner answers scoped questions.","glyph":"?","color":"#b06a14","softColor":"#F7F0E7"},
    defaults: {
      "questions": []
    },
    inputs: {
      "questions": {
        "required": false,
        "schema": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      },
      "suggestedAnswers": {
        "required": false,
        "schema": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      },
      "context": {
        "required": false,
        "schema": {
          "type": "string"
        }
      }
    },
    additionalInputs: [],
    execution: "map",
  },
  implementation_agent: {
    contract: {"category":"action","ports":["out"],"allowsFailurePort":true},
    ui: {"group":"agents","label":"Implementation agent","description":"Implements an approved or generated plan in a managed workspace.","glyph":"⌨","color":"#7C3AED","softColor":"#F2EBFD"},
    defaults: {},
    inputs: {
      "ticket": {
        "required": false,
        "schema": {
          "type": "object",
          "properties": {
            "identifier": {
              "type": "string"
            },
            "title": {
              "type": "string"
            },
            "description": {
              "type": "string"
            },
            "acceptanceCriteria": {
              "type": "string"
            },
            "labels": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "comments": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "author": {
                    "type": "string"
                  },
                  "body": {
                    "type": "string"
                  },
                  "createdAt": {
                    "type": "string"
                  }
                },
                "required": [
                  "author",
                  "body",
                  "createdAt"
                ],
                "additionalProperties": false
              }
            },
            "priorAnswers": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "questions": {
                    "type": "array",
                    "items": {
                      "type": "string"
                    }
                  },
                  "answer": {
                    "type": "string"
                  },
                  "answeredBy": {
                    "type": "string"
                  },
                  "answeredAt": {
                    "type": "string"
                  }
                },
                "required": [
                  "questions",
                  "answer"
                ],
                "additionalProperties": false
              }
            }
          },
          "required": [
            "identifier",
            "title",
            "description",
            "acceptanceCriteria",
            "labels",
            "comments",
            "priorAnswers"
          ],
          "additionalProperties": false
        }
      },
      "plan": {
        "required": false,
        "schema": {
          "type": "string"
        }
      }
    },
    additionalInputs: [],
    execution: "inline",
  },
  investigate: {
    contract: {"category":"action","ports":["out"],"allowsFailurePort":true},
    ui: {"group":"ticket","label":"Investigate","description":"Searches Jira and Slack for context on the ticket and builds an evidence-backed classification and theory for a human decision. Jira is always scoped to the configured project and Slack to the configured channels; a JQL template narrows within that project and cannot widen past it. Read-only: it never mutates the ticket, so every path leaving this block MUST end in a ticket mutation (Update ticket status or a label) or a Human question, otherwise the trigger poller re-runs the investigation (two LLM calls) on every poll.","glyph":"⌕","color":"#2563EB","softColor":"#E9EFFD"},
    defaults: {
      "providers": [
        "jira",
        "slack"
      ],
      "slackLookbackDays": 30,
      "maxResults": 10
    },
    inputs: {},
    additionalInputs: [],
    execution: "map",
  },
  leak_review: {
    contract: {"category":"action","ports":["out"],"allowsFailurePort":true},
    ui: {"group":"utility","label":"Leak review","description":"Screens the unpushed diff for secrets and sensitive data before publication.","glyph":"⊘","color":"#64748B","softColor":"#EEF1F5"},
    defaults: {
      "llmScan": true
    },
    inputs: {},
    additionalInputs: [],
    execution: "map",
  },
  loop: {
    contract: {"category":"control","ports":["continue","exhausted"],"allowsFailurePort":false},
    ui: {"group":"control","label":"Loop","description":"Repeats one cycle up to a bounded maximum attempt count.","glyph":"↻","color":"#35823f","softColor":"#E9F3EA"},
    defaults: {
      "maxAttempts": 3,
      "onExhaust": "fail"
    },
    inputs: {},
    additionalInputs: [],
    execution: "graph",
  },
  open_pr: {
    contract: {"category":"action","ports":["out"],"allowsFailurePort":true},
    ui: {"group":"vcs","label":"Open PR/MR","description":"Creates or reuses pull or merge requests from a successful Finalize output.","glyph":"⇪","color":"#3C43E7","softColor":"#ECECFD"},
    defaults: {
      "title": "[{{ticket_key}}] {{ticket_title}}",
      "body": "**Ticket:** [{{ticket_key}}]({{ticket_url}})\n\n## What changed\n{{change_summary}}"
    },
    inputs: {
      "repositories": {
        "required": true,
        "schema": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "provider": {
                "type": "string"
              },
              "repoPath": {
                "type": "string"
              },
              "branchName": {
                "type": "string"
              },
              "defaultBranch": {
                "type": "string"
              },
              "expectedHead": {
                "type": "string"
              },
              "pushedHead": {
                "type": "string"
              }
            },
            "required": [
              "provider",
              "repoPath",
              "branchName",
              "defaultBranch",
              "expectedHead",
              "pushedHead"
            ],
            "additionalProperties": false
          }
        }
      },
      "title": {
        "required": false,
        "schema": {
          "type": "string"
        }
      },
      "body": {
        "required": false,
        "schema": {
          "type": "string"
        }
      }
    },
    additionalInputs: [],
    execution: "inline",
  },
  planning_agent: {
    contract: {"category":"action","ports":["out"],"allowsFailurePort":true},
    ui: {"group":"agents","label":"Planning agent","description":"Researches the ticket and returns a plan or clarification questions.","glyph":"✦","color":"#7C3AED","softColor":"#F2EBFD"},
    defaults: {},
    inputs: {
      "ticket": {
        "required": false,
        "schema": {
          "type": "object",
          "properties": {
            "identifier": {
              "type": "string"
            },
            "title": {
              "type": "string"
            },
            "description": {
              "type": "string"
            },
            "acceptanceCriteria": {
              "type": "string"
            },
            "labels": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "comments": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "author": {
                    "type": "string"
                  },
                  "body": {
                    "type": "string"
                  },
                  "createdAt": {
                    "type": "string"
                  }
                },
                "required": [
                  "author",
                  "body",
                  "createdAt"
                ],
                "additionalProperties": false
              }
            },
            "priorAnswers": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "questions": {
                    "type": "array",
                    "items": {
                      "type": "string"
                    }
                  },
                  "answer": {
                    "type": "string"
                  },
                  "answeredBy": {
                    "type": "string"
                  },
                  "answeredAt": {
                    "type": "string"
                  }
                },
                "required": [
                  "questions",
                  "answer"
                ],
                "additionalProperties": false
              }
            }
          },
          "required": [
            "identifier",
            "title",
            "description",
            "acceptanceCriteria",
            "labels",
            "comments",
            "priorAnswers"
          ],
          "additionalProperties": false
        }
      },
      "comments": {
        "required": false,
        "schema": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "author": {
                "type": "string"
              },
              "body": {
                "type": "string"
              },
              "createdAt": {
                "type": "string"
              }
            },
            "required": [
              "author",
              "body",
              "createdAt"
            ],
            "additionalProperties": false
          }
        }
      },
      "priorAnswers": {
        "required": false,
        "schema": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "questions": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "answer": {
                "type": "string"
              },
              "answeredBy": {
                "type": "string"
              },
              "answeredAt": {
                "type": "string"
              }
            },
            "required": [
              "questions",
              "answer"
            ],
            "additionalProperties": false
          }
        }
      }
    },
    additionalInputs: [],
    execution: "inline",
  },
  post_pr_comment: {
    contract: {"category":"action","ports":["out"],"allowsFailurePort":true},
    ui: {"group":"vcs","label":"Post PR comment","description":"Posts a summary or response to the pull or merge request.","glyph":"❞","color":"#3C43E7","softColor":"#ECECFD"},
    defaults: {
      "body": "",
      "target": "all"
    },
    inputs: {
      "body": {
        "required": false,
        "schema": {
          "type": "string"
        }
      }
    },
    additionalInputs: [],
    execution: "map",
  },
  post_pr_review: {
    contract: {"category":"action","ports":["out"],"allowsFailurePort":false},
    ui: {"group":"vcs","label":"Post PR review","description":"Publishes compatible review findings against the exact reviewed commit.","glyph":"✎","color":"#3C43E7","softColor":"#ECECFD"},
    defaults: {},
    inputs: {
      "reviewResults": {
        "required": true,
        "schema": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "decision": {
                "type": "string",
                "enum": [
                  "approve",
                  "request_changes"
                ]
              },
              "findings": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "file": {
                      "type": "string"
                    },
                    "description": {
                      "type": "string"
                    },
                    "severity": {
                      "type": "string",
                      "enum": [
                        "Blocker",
                        "High",
                        "Medium",
                        "Nit"
                      ]
                    },
                    "startLine": {
                      "type": "number"
                    },
                    "endLine": {
                      "type": "number"
                    },
                    "repo": {
                      "type": "string"
                    }
                  },
                  "required": [
                    "file",
                    "description",
                    "severity"
                  ],
                  "additionalProperties": true
                }
              },
              "feedback": {
                "type": "string"
              }
            },
            "required": [
              "decision",
              "findings"
            ],
            "additionalProperties": true
          }
        }
      }
    },
    additionalInputs: [],
    execution: "map",
  },
  post_ticket_comment: {
    contract: {"category":"action","ports":["out"],"allowsFailurePort":true},
    ui: {"group":"ticket","label":"Post ticket comment","description":"Posts questions, plans, or status updates to the ticket.","glyph":"❝","color":"#2563EB","softColor":"#E9EFFD"},
    defaults: {
      "body": ""
    },
    inputs: {
      "body": {
        "required": false,
        "schema": {
          "type": "string"
        }
      }
    },
    additionalInputs: [],
    execution: "map",
  },
  prepare_workspace: {
    contract: {"category":"action","ports":["out"],"allowsFailurePort":true},
    ui: {"group":"workspace","label":"Prepare workspace","description":"Selects repositories and creates or reuses a managed code workspace.","glyph":"⊞","color":"#0f7f8b","softColor":"#E7F2F3"},
    defaults: {},
    inputs: {},
    additionalInputs: [],
    execution: "inline",
  },
  review_agent: {
    contract: {"category":"action","ports":["out"],"allowsFailurePort":true},
    ui: {"group":"agents","label":"Review agent","description":"Reviews the current workspace diff before publication.","glyph":"☰","color":"#7C3AED","softColor":"#F2EBFD"},
    defaults: {},
    inputs: {
      "reviewFeedback": {
        "required": false,
        "schema": {
          "type": "object",
          "properties": {
            "state": {
              "type": "string",
              "enum": [
                "changes_requested",
                "commented"
              ]
            },
            "author": {
              "type": "string"
            },
            "body": {
              "type": "string"
            }
          },
          "required": [
            "state",
            "author",
            "body"
          ],
          "additionalProperties": false
        }
      }
    },
    additionalInputs: [],
    execution: "inline",
  },
  run_checks: {
    contract: {"category":"action","ports":["out"],"allowsFailurePort":true},
    ui: {"group":"utility","label":"Run checks","description":"Legacy: runs configured or explicit validation commands in the workspace. Use Run scripts instead, which reports per-group verdicts and coverage.","glyph":"✓","color":"#64748B","softColor":"#EEF1F5"},
    defaults: {
      "commands": []
    },
    inputs: {},
    additionalInputs: [],
    execution: "map",
  },
  run_pre_pr_checks: {
    contract: {"category":"action","ports":["out"],"allowsFailurePort":true},
    ui: {"group":"utility","label":"Run scripts (publication gate)","description":"Runs the repository's gate groups (gateGroups when set, otherwise every group) on the repositories the run changed; they must pass before publication.","glyph":"◈","color":"#64748B","softColor":"#EEF1F5"},
    defaults: {},
    inputs: {},
    additionalInputs: [],
    execution: "inline",
  },
  run_scripts: {
    contract: {"category":"action","ports":["out"],"allowsFailurePort":true},
    ui: {"group":"utility","label":"Run scripts","description":"Runs named repository script groups in the run workspace. ok means nothing failed, while allPassed additionally requires that a selected group actually ran and passed.","glyph":"❯","color":"#64748B","softColor":"#EEF1F5"},
    defaults: {
      "groups": [
        "checks"
      ]
    },
    inputs: {},
    additionalInputs: [],
    execution: "map",
  },
  send_plan_approval: {
    contract: {"category":"action","ports":[],"allowsFailurePort":false},
    ui: {"group":"human","label":"Send plan for approval","description":"Creates a durable approval item and ends this path.","glyph":"☑","color":"#b06a14","softColor":"#F7F0E7"},
    defaults: {
      "mirrorComment": true
    },
    inputs: {
      "plan": {
        "required": true,
        "schema": {
          "type": "string"
        }
      },
      "assumptions": {
        "required": false,
        "schema": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    additionalInputs: [],
    execution: "map",
  },
  send_slack_message: {
    contract: {"category":"action","ports":["out"],"allowsFailurePort":true},
    ui: {"group":"utility","label":"Send Slack message","description":"Notifies the configured Slack channel about a workflow milestone.","glyph":"✉","color":"#64748B","softColor":"#EEF1F5"},
    defaults: {
      "message": "",
      "sendOn": "pr_ready"
    },
    inputs: {
      "message": {
        "required": false,
        "schema": {
          "type": "string"
        }
      }
    },
    additionalInputs: [],
    execution: "inline",
  },
  terminate: {
    contract: {"category":"control","ports":[],"allowsFailurePort":false},
    ui: {"group":"control","label":"Terminate","description":"Stops the current path with an explicit terminal outcome.","glyph":"■","color":"#35823f","softColor":"#E9F3EA"},
    defaults: {
      "terminalStatus": "done"
    },
    inputs: {},
    additionalInputs: [],
    execution: "graph",
  },
  transform: {
    contract: {"category":"action","ports":["out"],"allowsFailurePort":false},
    ui: {"group":"utility","label":"Transform","description":"Formats, cleans, converts, parses, replaces, or consolidates workflow values.","glyph":"↦","color":"#64748B","softColor":"#EEF1F5"},
    defaults: {},
    inputs: {},
    additionalInputs: [
      {
        "keyPattern": "^[A-Za-z_][A-Za-z0-9_-]*$",
        "schema": {
          "type": "unknown"
        }
      }
    ],
    execution: "graph",
  },
  trigger_plan_approved: {
    contract: {"category":"trigger","ports":["out"],"allowsFailurePort":false},
    ui: {"group":"trigger","label":"Plan approved","description":"Starts the pinned implementation path after plan approval.","glyph":"✔","color":"#D14343","softColor":"#FBECEC"},
    defaults: {},
    inputs: {},
    additionalInputs: [],
    execution: "graph",
  },
  trigger_pr_checks_failed: {
    contract: {"category":"trigger","ports":["out"],"allowsFailurePort":false},
    ui: {"group":"trigger","label":"PR checks failed","description":"Starts when external CI reports one or more failed checks.","glyph":"✗","color":"#D14343","softColor":"#FBECEC"},
    defaults: {
      "providers": [
        "github",
        "gitlab"
      ],
      "scope": "workflow_owned",
      "checkNames": [],
      "ignoreCheckNames": [],
      "githubAppSlugs": [
        "github-actions"
      ],
      "gitlabPipelineSources": [
        "merge_request_event"
      ],
      "maxFixAttemptsPerPr": 2
    },
    inputs: {},
    additionalInputs: [],
    execution: "graph",
  },
  trigger_pr_created: {
    contract: {"category":"trigger","ports":["out"],"allowsFailurePort":false},
    ui: {"group":"trigger","label":"PR created","description":"Starts from an allowed pull or merge request creation event.","glyph":"⎇","color":"#D14343","softColor":"#FBECEC"},
    defaults: {
      "providers": [
        "github",
        "gitlab"
      ],
      "scope": "workflow_owned"
    },
    inputs: {},
    additionalInputs: [],
    execution: "graph",
  },
  trigger_pr_merged: {
    contract: {"category":"trigger","ports":["out"],"allowsFailurePort":false},
    ui: {"group":"trigger","label":"PR merged","description":"Starts when an allowed pull or merge request is merged.","glyph":"◆","color":"#D14343","softColor":"#FBECEC"},
    defaults: {
      "providers": [
        "github",
        "gitlab"
      ],
      "scope": "workflow_owned"
    },
    inputs: {},
    additionalInputs: [],
    execution: "graph",
  },
  trigger_pr_ready: {
    contract: {"category":"trigger","ports":["out"],"allowsFailurePort":false},
    ui: {"group":"trigger","label":"PR ready for review","description":"Starts when a pull or merge request is ready for review.","glyph":"⎇","color":"#D14343","softColor":"#FBECEC"},
    defaults: {
      "providers": [
        "github",
        "gitlab"
      ],
      "scope": "any"
    },
    inputs: {},
    additionalInputs: [],
    execution: "graph",
  },
  trigger_pr_review: {
    contract: {"category":"trigger","ports":["out"],"allowsFailurePort":false},
    ui: {"group":"trigger","label":"PR review","description":"Starts from an allowed human pull or merge request review.","glyph":"✎","color":"#D14343","softColor":"#FBECEC"},
    defaults: {
      "providers": [
        "github"
      ],
      "on": [
        "changes_requested"
      ],
      "scope": "workflow_owned",
      "maxRunsPerPr": 10
    },
    inputs: {},
    additionalInputs: [],
    execution: "graph",
  },
  trigger_pr_updated: {
    contract: {"category":"trigger","ports":["out"],"allowsFailurePort":false},
    ui: {"group":"trigger","label":"PR updated","description":"Starts when the pull or merge request head commit changes.","glyph":"⟳","color":"#D14343","softColor":"#FBECEC"},
    defaults: {
      "providers": [
        "github",
        "gitlab"
      ],
      "scope": "any"
    },
    inputs: {},
    additionalInputs: [],
    execution: "graph",
  },
  trigger_schedule: {
    contract: {"category":"trigger","ports":["out"],"allowsFailurePort":false},
    ui: {"group":"trigger","label":"Schedule","description":"Starts the workflow on a recurring schedule in a timezone you configure.","glyph":"◷","color":"#D14343","softColor":"#FBECEC"},
    defaults: {
      "cron": "",
      "timezone": "UTC",
      "overlapPolicy": "skip",
      "catchUpGraceMinutes": 60,
      "taskTitle": "",
      "taskDescription": ""
    },
    inputs: {},
    additionalInputs: [],
    execution: "graph",
  },
  trigger_ticket_ai: {
    contract: {"category":"trigger","ports":["out"],"allowsFailurePort":false},
    ui: {"group":"trigger","label":"Ticket assigned to AI","description":"Starts when a configured ticket enters the AI workflow state.","glyph":"▶","color":"#D14343","softColor":"#FBECEC"},
    defaults: {},
    inputs: {},
    additionalInputs: [],
    execution: "graph",
  },
  trigger_webhook: {
    contract: {"category":"trigger","ports":["out"],"allowsFailurePort":false},
    ui: {"group":"trigger","label":"Webhook","description":"Starts from a signed webhook delivery sent by an external system (for example Zendesk).","glyph":"⇥","color":"#D14343","softColor":"#FBECEC"},
    defaults: {
      "authScheme": "hmac_sha256",
      "requireTimestamp": false,
      "timestampToleranceSeconds": 300,
      "mapSubject": "subject",
      "mapDescription": "description",
      "mapRequester": "requester",
      "mapPriority": "priority"
    },
    inputs: {},
    additionalInputs: [],
    execution: "graph",
  },
  update_ticket_status: {
    contract: {"category":"action","ports":["out"],"allowsFailurePort":true},
    ui: {"group":"ticket","label":"Update ticket status","description":"Moves the ticket to a configured provider status.","glyph":"▤","color":"#2563EB","softColor":"#E9EFFD"},
    defaults: {
      "target": "ai_review"
    },
    inputs: {
      "target": {
        "required": false,
        "schema": {
          "type": "string"
        }
      }
    },
    additionalInputs: [],
    execution: "inline",
  },
};

export const BLOCK_TYPE_SPECS: Record<WorkflowBlockType, BlockTypeSpec> = {
  arthur_injection_check: BLOCK_CATALOG.arthur_injection_check.contract,
  branch: BLOCK_CATALOG.branch.contract,
  call_llm: BLOCK_CATALOG.call_llm.contract,
  complete_pr_check: BLOCK_CATALOG.complete_pr_check.contract,
  create_pr_check: BLOCK_CATALOG.create_pr_check.contract,
  fetch_pr_context: BLOCK_CATALOG.fetch_pr_context.contract,
  finalize_workspace: BLOCK_CATALOG.finalize_workspace.contract,
  fix_agent: BLOCK_CATALOG.fix_agent.contract,
  generic_agent: BLOCK_CATALOG.generic_agent.contract,
  human_question: BLOCK_CATALOG.human_question.contract,
  implementation_agent: BLOCK_CATALOG.implementation_agent.contract,
  investigate: BLOCK_CATALOG.investigate.contract,
  leak_review: BLOCK_CATALOG.leak_review.contract,
  loop: BLOCK_CATALOG.loop.contract,
  open_pr: BLOCK_CATALOG.open_pr.contract,
  planning_agent: BLOCK_CATALOG.planning_agent.contract,
  post_pr_comment: BLOCK_CATALOG.post_pr_comment.contract,
  post_pr_review: BLOCK_CATALOG.post_pr_review.contract,
  post_ticket_comment: BLOCK_CATALOG.post_ticket_comment.contract,
  prepare_workspace: BLOCK_CATALOG.prepare_workspace.contract,
  review_agent: BLOCK_CATALOG.review_agent.contract,
  run_checks: BLOCK_CATALOG.run_checks.contract,
  run_pre_pr_checks: BLOCK_CATALOG.run_pre_pr_checks.contract,
  run_scripts: BLOCK_CATALOG.run_scripts.contract,
  send_plan_approval: BLOCK_CATALOG.send_plan_approval.contract,
  send_slack_message: BLOCK_CATALOG.send_slack_message.contract,
  terminate: BLOCK_CATALOG.terminate.contract,
  transform: BLOCK_CATALOG.transform.contract,
  trigger_plan_approved: BLOCK_CATALOG.trigger_plan_approved.contract,
  trigger_pr_checks_failed: BLOCK_CATALOG.trigger_pr_checks_failed.contract,
  trigger_pr_created: BLOCK_CATALOG.trigger_pr_created.contract,
  trigger_pr_merged: BLOCK_CATALOG.trigger_pr_merged.contract,
  trigger_pr_ready: BLOCK_CATALOG.trigger_pr_ready.contract,
  trigger_pr_review: BLOCK_CATALOG.trigger_pr_review.contract,
  trigger_pr_updated: BLOCK_CATALOG.trigger_pr_updated.contract,
  trigger_schedule: BLOCK_CATALOG.trigger_schedule.contract,
  trigger_ticket_ai: BLOCK_CATALOG.trigger_ticket_ai.contract,
  trigger_webhook: BLOCK_CATALOG.trigger_webhook.contract,
  update_ticket_status: BLOCK_CATALOG.update_ticket_status.contract,
};

export const GENERATED_TRIGGER_BLOCK_TYPES: readonly WorkflowBlockType[] = [
  "trigger_plan_approved",
  "trigger_pr_checks_failed",
  "trigger_pr_created",
  "trigger_pr_merged",
  "trigger_pr_ready",
  "trigger_pr_review",
  "trigger_pr_updated",
  "trigger_schedule",
  "trigger_ticket_ai",
  "trigger_webhook",
];
