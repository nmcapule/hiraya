export function boundedNotificationVisibility(input: { error: boolean; notice: boolean; trash: number; apps: number }, maximumRows = 3) {
  const total = Number(input.error) + Number(input.notice) + input.trash + input.apps;
  let slots = Math.max(0, total > maximumRows ? maximumRows - 1 : maximumRows);
  const showError = input.error && slots-- > 0;
  const visibleTrash = Math.min(input.trash, Math.max(0, slots));
  slots -= visibleTrash;
  const showNotice = input.notice && slots-- > 0;
  const visibleApps = Math.min(input.apps, Math.max(0, slots));
  const hidden = total - Number(showError) - visibleTrash - Number(showNotice) - visibleApps;
  return { total, showError, visibleTrash, showNotice, visibleApps, hidden };
}
