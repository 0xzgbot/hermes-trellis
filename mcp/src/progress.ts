/** Forward ComfyUI progress to Hermes as MCP notifications/progress. */

export interface ToolExtra {
  _meta?: { progressToken?: string | number };
  sendNotification?: (notification: {
    method: "notifications/progress";
    params: { progressToken: string | number; progress: number; total?: number; message?: string };
  }) => Promise<void>;
}

export function reportProgress(extra: ToolExtra | undefined, progress: number, total: number, message: string): void {
  const token = extra?._meta?.progressToken;
  if (token === undefined || !extra?.sendNotification) return;
  void extra.sendNotification({
    method: "notifications/progress",
    params: { progressToken: token, progress, total, message },
  }).catch(() => undefined);
}
