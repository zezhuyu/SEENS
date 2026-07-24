export function shouldRewriteMusicIntro({
  env = process.env,
  firstTrack,
  playlistLength,
  playlistChanged,
  trackContext,
}) {
  return env.DJ_ENRICH_INTRO === '1' &&
    firstTrack?.source !== 'plugin' &&
    playlistLength > 0 &&
    (playlistChanged || Boolean(trackContext));
}

export function getTtsDeliveryPolicy(triggerType, shouldSynthesize) {
  const deferred = triggerType === 'user-chat';
  return {
    deferred,
    pending: deferred && Boolean(shouldSynthesize),
  };
}

export function alignIntroToFirstTrack(say, firstTrack) {
  if (!firstTrack || !say || firstTrack.source === 'plugin') {
    return { say, changed: false };
  }

  const title = (firstTrack.resolvedTitle ?? firstTrack.title ?? '').toLowerCase();
  const artist = (firstTrack.resolvedArtist ?? firstTrack.artist ?? '').toLowerCase();
  const sayLower = say.toLowerCase();
  const significantWords = value => value.split(/\s+/).filter(word => word.length > 2);
  const titleWords = significantWords(title);
  const artistWords = significantWords(artist);
  const titleMentioned = titleWords.length === 0 || titleWords.some(word => sayLower.includes(word));
  const artistMentioned = artistWords.length === 0 || artistWords.some(word => sayLower.includes(word));

  if (titleMentioned || artistMentioned) return { say, changed: false };

  const displayTitle = firstTrack.resolvedTitle ?? firstTrack.title;
  const displayArtist = firstTrack.resolvedArtist ?? firstTrack.artist ?? '';
  return {
    say: displayArtist
      ? `First up is ${displayTitle} by ${displayArtist}.`
      : `First up is ${displayTitle}.`,
    changed: true,
  };
}
