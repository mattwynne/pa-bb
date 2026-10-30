// Owner-controlled filing policy, deliberately separate from Docs/upload/sharing.
export const filingApprovalSetting = {
  type: 'select' as const, label: 'Approval for filing I request', default: 'access_changes',
  options: ['access_changes', 'never'],
  experimental_optionLabels: { access_changes: 'Only when access changes', never: 'Never for filing I request' },
  description: 'Folder creation and moves only. Empty folders inherit the selected destination’s access without approval; later file moves are evaluated separately. Access inspection, capability checks and verification always stay on. Does not change Docs editing, upload or explicit sharing approvals. Access changes are reported afterward.',
};
