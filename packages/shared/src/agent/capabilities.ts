/**
 * Static capability flags a provider MAY support.
 * Effective capability = static flags ∩ what the runtime adapter reports.
 * Derived from plan §8.1 capability matrix.
 */
export interface AgentCapabilityFlags {
  /** token/message streaming */
  streaming: boolean;
  /** reasoning summary events (never raw reasoning by default) */
  reasoningSummary: boolean;
  /** structured tool.started/tool.completed events */
  toolEvents: boolean;
  /** interrupt() with ownership guarantee */
  interrupt: boolean;
  /** steer() mid-turn input */
  steer: boolean;
  /** resumable sessions across restarts */
  resume: boolean;
  modelSelection: boolean;
  modeSelection: boolean;
  thinkingOption: boolean;
  /** provider-originated permission prompts */
  permissionPrompts: boolean;
  /** provider can consume MCP tools */
  mcpTools: boolean;
  /** image content parts in TurnInput */
  imageInput: boolean;
  slashCommands: boolean;
  usage: boolean;
  /** optional streamHistory() for import/history */
  streamHistory: boolean;
}

export const NO_CAPABILITIES: AgentCapabilityFlags = {
  streaming: false,
  reasoningSummary: false,
  toolEvents: false,
  interrupt: false,
  steer: false,
  resume: false,
  modelSelection: false,
  modeSelection: false,
  thinkingOption: false,
  permissionPrompts: false,
  mcpTools: false,
  imageInput: false,
  slashCommands: false,
  usage: false,
  streamHistory: false,
};
