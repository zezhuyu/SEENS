export function startProgressiveResolution(tracks, {
  resolveFirst,
  resolveRemaining,
}) {
  const [head, ...tail] = tracks;
  const first = head ? Promise.resolve().then(() => resolveFirst(head)) : Promise.resolve(null);
  const remaining = tail.map(track => Promise.resolve().then(() => resolveRemaining(track)));
  return {
    first,
    all: Promise.all([first, ...remaining]),
  };
}
