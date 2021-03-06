import {IResolverObject as ResolverObject} from 'graphql-tools';
import fetch from 'node-fetch';
import {Context, Table} from './context';

type Resolver<Source = never> = ResolverObject<Source, Context>;

export const Query: Resolver = {
  async search(_, {query}: {query?: string}, context) {
    if (!query?.length) {
      return {series: []};
    }

    const {results} = await tmdbFetch<{results: any[]}>(
      `/search/tv?query=${encodeURIComponent(query)}`,
    );
    const cappedResults = results.slice(0, 5);
    const existingSeries =
      cappedResults.length > 0
        ? await context.db
            .select('*')
            .from(Table.Series)
            .whereIn(
              'tmdbId',
              cappedResults.map(({id}) => String(id)),
            )
        : [];

    const idToResult = new Map(
      existingSeries.map((series) => [series.tmdbId, series]),
    );
    const unmatchedSeries = cappedResults.filter(
      ({id}) => !idToResult.has(String(id)),
    );

    await Promise.all(
      unmatchedSeries.map(async (unmatchedSeries) => {
        const series = await loadTmdbSeries(unmatchedSeries.id, context);
        idToResult.set(series.tmdbId, series);
      }),
    );

    const returnedSeries = cappedResults.map(({id}) =>
      idToResult.get(String(id)),
    );
    return {series: returnedSeries};
  },
  watch(_, {id}: {id: string}, {watchLoader}) {
    return watchLoader.load(fromGid(id).id);
  },
  series(_, {id}: {id: string}, {seriesLoader}) {
    return seriesLoader.load(fromGid(id).id);
  },
  watchThrough(_, {id}: {id: string}, {watchThroughLoader}) {
    return watchThroughLoader.load(fromGid(id).id);
  },
  async watchThroughs(_, __, {db, watchThroughLoader}) {
    const watchThroughs = await db
      .select('id')
      .from(Table.WatchThroughs)
      .whereNot({status: 'FINISHED'})
      .limit(50);

    return Promise.all(
      watchThroughs.map(({id}) => watchThroughLoader.load(id)),
    );
  },
};

interface Slice {
  episodeNumber: number;
  seasonNumber: number;
}

export const Mutation: Resolver = {
  async watchEpisode(
    _,
    {
      episode: episodeGid,
      watchThrough: watchThroughGid,
      rating,
      notes,
      startedAt,
      finishedAt,
    }: {
      episode: string;
      watchThrough?: string;
      rating?: number;
      notes?: string;
      startedAt?: string;
      finishedAt?: string;
    },
    {db, watchLoader, episodeLoader, watchThroughLoader},
  ) {
    const episodeId = episodeGid && fromGid(episodeGid).id;
    const watchThroughId = watchThroughGid && fromGid(watchThroughGid).id;

    const [watchId] = await db
      .insert({
        episodeId,
        watchThroughId,
        rating,
        notes,
        startedAt,
        finishedAt,
      })
      .into(Table.Watches)
      .returning('id');

    if (watchThroughId && watchId) {
      await Promise.all([
        db
          .update({watchId})
          .from(Table.WatchThroughEpisodes)
          .where({watchThroughId, episodeId}),
        db
          .update({updatedAt: finishedAt || startedAt || 'now()'})
          .from(Table.WatchThroughs)
          .where({id: watchThroughId}),
      ]);

      await db
        .update({watchId})
        .from(Table.WatchThroughEpisodes)
        .where({watchThroughId, episodeId});
    }

    const [watch, episode, watchThrough] = await Promise.all([
      watchLoader.load(watchId),
      episodeLoader.load(episodeId),
      watchThroughId
        ? watchThroughLoader.load(watchThroughId)
        : Promise.resolve(null),
    ]);

    return {watch, episode, watchThrough};
  },
  async skipEpisode(
    _,
    {
      episode: episodeGid,
      watchThrough: watchThroughGid,
      notes,
      at,
    }: {episode: string; watchThrough?: string; notes?: string; at?: string},
    {db, skipLoader, episodeLoader, watchThroughLoader},
  ) {
    const episodeId = episodeGid && fromGid(episodeGid).id;
    const watchThroughId = watchThroughGid && fromGid(watchThroughGid).id;

    const [skipId] = await db
      .insert({
        episodeId,
        watchThroughId,
        notes,
        at,
      })
      .into(Table.Skips)
      .returning('id');

    if (watchThroughId && skipId) {
      await Promise.all([
        db
          .update({skipId})
          .from(Table.WatchThroughEpisodes)
          .where({watchThroughId, episodeId}),
        db
          .update({updatedAt: at || 'now()'})
          .from(Table.WatchThroughs)
          .where({id: watchThroughId}),
      ]);
    }

    const [skip, episode, watchThrough] = await Promise.all([
      skipLoader.load(skipId),
      episodeLoader.load(episodeId),
      watchThroughId
        ? watchThroughLoader.load(watchThroughId)
        : Promise.resolve(null),
    ]);

    return {skip, episode, watchThrough};
  },
  async startWatchThrough(
    _,
    {
      series: seriesGid,
      seasons: seasonGids,
      episodes: episodeGids,
      includeSpecials = false,
    }: {
      series: string;
      seasons?: string[];
      episodes?: string[];
      includeSpecials?: boolean;
    },
    {db, watchThroughLoader},
  ) {
    const {id: seriesId} = fromGid(seriesGid);

    const watchThroughId = await db.transaction(async (trx) => {
      const episodes = [
        ...((episodeGids && episodeGids.map((gid) => fromGid(gid).id)) || []),
      ];

      if (seasonGids) {
        episodes.push(
          ...((await trx
            .select({id: 'Episodes.id'})
            .from(Table.Episodes)
            .join('Seasons', 'Seasons.id', '=', 'Episodes.seasonId')
            .whereIn(
              'Episodes.seasonId',
              seasonGids.map((gid) => fromGid(gid).id),
            )
            .orderBy(['Seasons.number', 'Episodes.number'])) as {
            id: string;
          }[]).map(({id}) => id),
        );
      }

      if (seasonGids == null && episodeGids == null) {
        episodes.push(
          ...((await trx
            .select({id: 'Episodes.id'})
            .from(Table.Episodes)
            .join('Seasons', 'Seasons.id', '=', 'Episodes.seasonId')
            .where((clause) => {
              clause.where({'Episodes.seriesId': seriesId});

              if (!includeSpecials) {
                clause.whereNot({'Seasons.number': 0});
              }
            })
            .orderBy(['Seasons.number', 'Episodes.number'])) as {
            id: string;
          }[]).map(({id}) => id),
        );
      }

      const [{id: watchThroughId}] = await trx
        .insert(
          {
            startedAt: new Date(),
            seriesId,
          },
          ['id'],
        )
        .into(Table.WatchThroughs);

      await trx
        .insert(
          episodes.map((episodeId, index) => ({
            index,
            episodeId,
            watchThroughId,
          })),
        )
        .into(Table.WatchThroughEpisodes);

      return watchThroughId;
    });

    const watchThrough = await watchThroughLoader.load(watchThroughId);

    return {watchThrough};
  },
  async deleteWatch(_, {id: gid}: {id: string}, {db, watchThroughLoader}) {
    const {id} = fromGid(gid);
    const [{watchThroughId}] = await db
      .select('watchThroughId')
      .from(Table.Watches)
      .where({id});
    await db
      .from(Table.Watches)
      .where({id})
      .delete();

    return {
      deletedWatchId: gid,
      watchThrough: watchThroughId
        ? watchThroughLoader.load(watchThroughId)
        : null,
    };
  },
  async deleteWatchThrough(_, {id: gid}: {id: string}, {db}) {
    const {id} = fromGid(gid);
    await db
      .from(Table.WatchThroughs)
      .where({id})
      .delete();
    return {deletedWatchThroughId: gid};
  },
  async watchEpisodesFromSeries(
    _,
    {
      series: seriesGid,
      slice,
    }: {series: string; slice?: {from?: Slice; to?: Slice}},
    {db, seriesLoader},
  ) {
    const {id: seriesId} = fromGid(seriesGid);

    await db.transaction(async (trx) => {
      const episodes = (await trx
        .select({id: 'Episodes.id'})
        .from(Table.Episodes)
        .join('Seasons', 'Seasons.id', '=', 'Episodes.seasonId')
        .where((clause) => {
          clause.where({'Episodes.seriesId': seriesId});

          const {from, to} = slice ?? {};

          if (from) {
            clause.andWhere((clause) => {
              clause
                .where('Seasons.number', '>', from.seasonNumber)
                .orWhere((clause) => {
                  clause
                    .where('Seasons.number', '=', from.seasonNumber)
                    .andWhere('Episodes.number', '>', from.episodeNumber - 1);
                });
            });
          }

          if (to) {
            clause.andWhere((clause) => {
              clause
                .where('Seasons.number', '<', to.seasonNumber)
                .orWhere((clause) => {
                  clause
                    .where('Seasons.number', '=', to.seasonNumber)
                    .andWhere('Episodes.number', '<', to.episodeNumber + 1);
                });
            });
          }
        })) as {id: string}[];

      await trx
        .insert(
          episodes.map(({id: episodeId}) => ({
            episodeId,
          })),
        )
        .into(Table.Watches);
    });

    const series = await seriesLoader.load(seriesId);
    return {series};
  },
};

export const Watchable: Resolver = {
  __resolveType: resolveType,
};

export const Reviewable: Resolver = {
  __resolveType: resolveType,
};

export const WatchThroughEpisodeAction: Resolver = {
  __resolveType: resolveType,
};

export const Series: Resolver<{
  id: string;
  poster?: string;
}> = {
  id: ({id}) => toGid(id, 'Series'),
  async season({id}, {number}: {number: number}, {db}) {
    const seasonResults = await db
      .select('*')
      .from(Table.Seasons)
      .where({seriesId: id, number})
      .limit(1);
    return seasonResults[0] || null;
  },
  async seasons({id}, _, {db, seasonLoader}) {
    const seasons = await db
      .select('id')
      .from(Table.Seasons)
      .where({seriesId: id});
    return Promise.all(seasons.map(({id}) => seasonLoader.load(id)));
  },
  async episode(
    {id},
    {number, seasonNumber}: {number: number; seasonNumber: string},
    {db},
  ) {
    const [seasonResult] = await db
      .select('id')
      .from(Table.Seasons)
      .where({seriesId: id, number: seasonNumber})
      .limit(1);
    const episodeResult = seasonResult
      ? await db
          .select('*')
          .from(Table.Episodes)
          .where({seriesId: id, seasonId: seasonResult.id, number})
          .limit(1)
      : null;
    return episodeResult && episodeResult[0];
  },
  async episodes({id}, _, {db, episodeLoader}) {
    const seasons = await db
      .select('id')
      .from(Table.Episodes)
      .where({seriesId: id});
    return Promise.all(seasons.map(({id}) => episodeLoader.load(id)));
  },
  poster({poster}) {
    return poster ? {source: poster} : null;
  },
};

export const Season: Resolver = {
  id: ({id}) => toGid(id, 'Season'),
  series({seriesId}, _, {seriesLoader}) {
    return seriesLoader.load(seriesId);
  },
  async episodes({id, seriesId}, _, {db, episodeLoader}) {
    const episodes = await db
      .select('id')
      .from(Table.Episodes)
      .where({seriesId, seasonId: id});
    return Promise.all(episodes.map(({id}) => episodeLoader.load(id)));
  },
  poster({poster}) {
    return poster ? {source: poster} : null;
  },
  isSpecials({number}) {
    return number === 0;
  },
};

export const Episode: Resolver = {
  id: ({id}) => toGid(id, 'Episode'),
  series({seriesId}, _, {seriesLoader}) {
    return seriesLoader.load(seriesId);
  },
  season({seasonId}, _, {seasonLoader}) {
    return seasonLoader.load(seasonId);
  },
  still({still}) {
    return still ? {source: still} : null;
  },
  async watches({id}, _, {db, watchLoader}) {
    const watches = await db
      .select('id')
      .from(Table.Watches)
      .where({episodeId: id})
      .limit(50);
    return Promise.all(watches.map(({id}) => watchLoader.load(id)));
  },
  async latestWatch({id}, __, {db, watchLoader}) {
    const [lastWatch] = await db
      .select('id')
      .from(Table.Watches)
      .where({episodeId: id})
      .orderBy('createdAt', 'desc')
      .limit(1);

    return lastWatch ? watchLoader.load(lastWatch.id) : null;
  },
};

export const WatchThroughEpisode: Resolver<{
  id: string;
  watchId?: string;
  skipId?: string;
  watchThroughId: string;
  episodeId?: string;
}> = {
  id: ({id}) => toGid(id, 'WatchThroughEpisode'),
  episode({episodeId}, _, {episodeLoader}) {
    return episodeId ? episodeLoader.load(episodeId) : null;
  },
  watchThrough({watchThroughId}, _, {watchThroughLoader}) {
    return watchThroughLoader.load(watchThroughId);
  },
  finished({watchId, skipId}) {
    return watchId != null || skipId != null;
  },
  action({watchId, skipId}, _, {watchLoader, skipLoader}) {
    if (watchId != null)
      return watchLoader.load(watchId).then(addResolvedType('Watch'));

    if (skipId != null)
      return skipLoader.load(skipId).then(addResolvedType('Skip'));

    return null;
  },
};

export const WatchThrough: Resolver<{id: string; seriesId: string}> = {
  id: ({id}) => toGid(id, 'WatchThrough'),
  series({seriesId}, _, {seriesLoader}) {
    return seriesLoader.load(seriesId);
  },
  async watches({id}, _, {db, watchLoader}) {
    const watches = await db
      .select('id')
      .from(Table.Watches)
      .where({watchThroughId: id})
      .limit(50);
    return Promise.all(watches.map(({id}) => watchLoader.load(id)));
  },
  async episodes(
    {id},
    {
      watched,
      finished,
    }: {watched?: 'WATCHED' | 'UNWATCHED'; finished?: boolean},
    {db},
  ) {
    const episodes = await db
      .from(Table.WatchThroughEpisodes)
      .select('*')
      .where((clause) => {
        clause.where({watchThroughId: id});

        if (finished) {
          clause.whereNotNull('watchId').orWhereNotNull('skipId');
        }

        if (watched === 'WATCHED') {
          clause.whereNotNull('watchId');
        } else if (watched === 'UNWATCHED') {
          clause.whereNull('watchId');
        }
      })
      .orderBy('index', 'asc')
      .limit(50);

    return episodes;
  },
  async unfinishedEpisodeCount({id: watchThroughId}, _, {db}) {
    const [{count}] = await db
      .from(Table.WatchThroughEpisodes)
      .join('Episodes', 'Episodes.id', '=', 'WatchThroughEpisodes.episodeId')
      .where((clause) => {
        clause
          .where({watchThroughId})
          .whereNull('WatchThroughEpisodes.watchId')
          .whereNull('WatchThroughEpisodes.skipId');
      })
      .where(
        'Episodes.firstAired',
        '<',
        db.raw(`CURRENT_DATE + interval '1 day'`),
      )
      .count({count: 'WatchThroughEpisodes.id'});

    return parseInt(count, 10);
  },
  async nextEpisode({id}, _, {db, episodeLoader}) {
    const [episodeId] = (await db
      .from(Table.WatchThroughEpisodes)
      .pluck('episodeId')
      .where({watchThroughId: id})
      .andWhere((clause) => clause.whereNull('skipId').whereNull('watchId'))
      .orderBy('index', 'asc')
      .limit(50)) as string[];

    return episodeId ? episodeLoader.load(episodeId) : null;
  },
  async lastAction({id}, _, {db, watchLoader, skipLoader}) {
    const [action] = await db
      .from(Table.WatchThroughEpisodes)
      .select(['watchId', 'skipId'])
      .where((clause) => {
        clause.whereNotNull('watchId').orWhereNotNull('skipId');
      })
      .where({watchThroughId: id})
      .orderBy('index', 'desc')
      .limit(1);

    if (action == null) {
      return null;
    }

    const {watchId, skipId} = action;

    if (watchId != null)
      return watchLoader.load(watchId).then(addResolvedType('Watch'));

    if (skipId != null)
      return skipLoader.load(skipId).then(addResolvedType('Skip'));

    return null;
  },
  async lastEpisode({id}, _, {db}) {
    const [lastEpisode] = await db
      .from(Table.WatchThroughEpisodes)
      .select('*')
      .where((clause) => {
        clause.whereNotNull('watchId').orWhereNotNull('skipId');
      })
      .where({watchThroughId: id})
      .orderBy('index', 'desc')
      .limit(1);

    return lastEpisode || null;
  },
};

export const Watch: Resolver<{
  id: string;
  episodeId?: string;
  watchThroughId?: string;
}> = {
  id: ({id}) => toGid(id, 'Watch'),
  media({episodeId}, _, {episodeLoader}) {
    return episodeId
      ? episodeLoader.load(episodeId).then(addResolvedType('Episode'))
      : null;
  },
  watchThrough({watchThroughId}, _, {watchThroughLoader}) {
    return watchThroughId ? watchThroughLoader.load(watchThroughId) : null;
  },
};

export const Skip: Resolver<{
  id: string;
  episodeId?: string;
  watchThroughId?: string;
}> = {
  id: ({id}) => toGid(id, 'Skip'),
  media({episodeId}, _, {episodeLoader}) {
    return episodeId
      ? episodeLoader.load(episodeId).then(addResolvedType('Episode'))
      : null;
  },
  watchThrough({watchThroughId}, _, {watchThroughLoader}) {
    return watchThroughId ? watchThroughLoader.load(watchThroughId) : null;
  },
};

function addResolvedType(type: string) {
  return (rest: any) => ({...rest, __resolvedType: type});
}

function resolveType(obj: {__resolvedType?: string; id: string}) {
  return obj.__resolvedType ?? fromGid(obj.id).type;
}

function tmdbAirDateToDate(date?: string) {
  if (!date) {
    return null;
  }

  const match = /(?<year>[0-9]{4})-(?<month>[0-9]{2})-(?<day>[0-9]{2})/.exec(
    date,
  );

  if (match == null) {
    return null;
  }

  const {year, month, day} = match.groups!;
  return new Date(
    parseInt(year, 10),
    parseInt(month, 10) - 1,
    parseInt(day, 10),
  );
}

function tmdbStatusToEnum(status: TmdbSeries['status']) {
  switch (status) {
    case 'Returning Series':
      return 'RETURNING';
    case 'Ended':
      return 'ENDED';
    case 'Canceled':
      return 'CANCELLED';
    default: {
      throw new Error(`Unrecognized status: ${status}`);
    }
  }
}

async function tmdbFetch<T = unknown>(path: string): Promise<T> {
  const fetched = await fetch(`https://api.themoviedb.org/3${path}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${process.env.TMDB_ACCESS_TOKEN}`,
    },
  });

  return fetched.json();
}

interface TmdbSeries {
  name: string;
  status: string;
  seasons: TmdbSeriesSeason[];
  // eslint-disable-next-line @typescript-eslint/camelcase
  air_date?: string;
  // eslint-disable-next-line @typescript-eslint/camelcase
  first_air_date?: string;
  overview?: string;
  // eslint-disable-next-line @typescript-eslint/camelcase
  poster_path?: string;
  // eslint-disable-next-line @typescript-eslint/camelcase
  number_of_seasons?: number;
}

interface TmdbExternalIds {
  // eslint-disable-next-line @typescript-eslint/camelcase
  imdb_id: string;
}

interface TmdbSeriesSeason {
  // eslint-disable-next-line @typescript-eslint/camelcase
  season_number: number;
}

interface TmdbSeason {
  // eslint-disable-next-line @typescript-eslint/camelcase
  season_number: number;
  episodes: TmdbEpisode[];
  // eslint-disable-next-line @typescript-eslint/camelcase
  air_date?: string;
  overview?: string;
  // eslint-disable-next-line @typescript-eslint/camelcase
  poster_path?: string;
}

interface TmdbEpisode {
  name: string;
  overview?: string;
  // eslint-disable-next-line @typescript-eslint/camelcase
  air_date?: string;
  // eslint-disable-next-line @typescript-eslint/camelcase
  episode_number: number;
  // eslint-disable-next-line @typescript-eslint/camelcase
  season_number: number;
  // eslint-disable-next-line @typescript-eslint/camelcase
  still_path?: string;
}

async function loadTmdbSeries(tmdbId: string, {db}: Pick<Context, 'db'>) {
  const [seriesResult, seriesIds] = await Promise.all([
    tmdbFetch<TmdbSeries>(`/tv/${tmdbId}`),
    tmdbFetch<TmdbExternalIds>(`/tv/${tmdbId}/external_ids`),
  ] as const);

  const seasonResults = (
    await Promise.all(
      seriesResult.seasons.map((season) =>
        tmdbFetch<TmdbSeason>(`/tv/${tmdbId}/season/${season.season_number}`),
      ),
    )
  ).filter(({season_number: seasonNumber}) => seasonNumber != null);

  return db.transaction(async (trx) => {
    const [series] = await trx
      .insert(
        {
          tmdbId,
          imdbId: seriesIds.imdb_id,
          name: seriesResult.name,
          firstAired: tmdbAirDateToDate(seriesResult.first_air_date),
          status: tmdbStatusToEnum(seriesResult.status),
          overview: seriesResult.overview || null,
          poster: seriesResult.poster_path
            ? `https://image.tmdb.org/t/p/original${seriesResult.poster_path}`
            : null,
        },
        '*',
      )
      .into(Table.Series);

    const {id: seriesId} = series;

    const seasonsToInsert = seasonResults.map((season) => ({
      seriesId,
      number: season.season_number,
      firstAired: tmdbAirDateToDate(season.air_date),
      overview: season.overview ?? null,
      status:
        season.season_number === seriesResult.number_of_seasons &&
        tmdbStatusToEnum(seriesResult.status) === 'RETURNING'
          ? 'CONTINUING'
          : 'ENDED',
      poster: season.poster_path
        ? `https://image.tmdb.org/t/p/original${season.poster_path}`
        : null,
    }));

    const seasonIds: {id: string; number: number}[] =
      seasonsToInsert.length > 0
        ? await trx
            .insert(seasonsToInsert, ['id', 'number'])
            .into(Table.Seasons)
        : [];

    const seasonToId = new Map(seasonIds.map(({id, number}) => [number, id]));

    const episodesToInsert = seasonResults.reduce<any[]>((episodes, season) => {
      return [
        ...episodes,
        ...season.episodes.map((episode) => ({
          seriesId,
          seasonId: seasonToId.get(episode.season_number),
          number: episode.episode_number,
          title: episode.name,
          firstAired: tmdbAirDateToDate(episode.air_date),
          overview: episode.overview || null,
          still: episode.still_path
            ? `https://image.tmdb.org/t/p/original${episode.still_path}`
            : null,
        })),
      ];
    }, []);

    if (episodesToInsert.length > 0) {
      await trx.insert(episodesToInsert, ['id']).into(Table.Episodes);
    }

    return series;
  });
}

function fromGid(gid: string) {
  const {type, id} = /gid:\/\/watch\/(?<type>\w+)\/(?<id>[\w-]+)/.exec(
    gid,
  )!.groups!;
  return {type, id};
}

function toGid(id: string, type: string) {
  return `gid://watch/${type}/${id}`;
}
