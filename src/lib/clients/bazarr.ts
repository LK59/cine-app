import { config } from "@/lib/config";
import { fetchJson } from "@/lib/http";

const { url, apiKey } = config.bazarr;
const headers = { "X-API-KEY": apiKey };

export interface BazarrWantedMovie {
  title: string;
  radarrId: number;
  sceneName?: string;
  missing_subtitles: { code2: string; name: string }[];
}

export interface BazarrWantedEpisode {
  seriesTitle: string;
  episodeTitle: string;
  episode_number: string;
  sonarrSeriesId: number;
  sonarrEpisodeId: number;
  sceneName?: string;
  missing_subtitles: { code2: string; name: string }[];
}

export interface BazarrSubtitleFile {
  name: string;
  code2: string;
  path: string;
  forced: boolean;
  hi: boolean;
}

export interface BazarrAudioLanguage {
  name: string;
  code2: string;
}

export interface BazarrMovieDetails {
  radarrId: number;
  subtitles: BazarrSubtitleFile[];
  missing_subtitles: { code2: string; name: string }[];
  audio_language: BazarrAudioLanguage[];
}

export interface BazarrEpisodeDetails {
  sonarrEpisodeId: number;
  season: number;
  episode: number;
  subtitles: BazarrSubtitleFile[];
  missing_subtitles: { code2: string; name: string }[];
  audio_language: BazarrAudioLanguage[];
}

export interface BazarrSubtitleCandidate {
  provider: string;
  language: string;
  forced: string;
  hearing_impaired: string;
  original_format: string;
  score: number;
  release_info: string[];
  matches: string[];
  dont_matches: string[];
  uploader?: string;
  url?: string;
  subtitle: string;
}

export const bazarr = {
  getStatus: () => fetchJson<{ data: any }>(`${url}/api/system/status`, { headers }),
  getWantedMovies: (length = 25) =>
    fetchJson<{ data: BazarrWantedMovie[]; total: number }>(
      `${url}/api/movies/wanted?start=0&length=${length}`,
      { headers }
    ),
  getWantedEpisodes: (length = 25) =>
    fetchJson<{ data: BazarrWantedEpisode[]; total: number }>(
      `${url}/api/episodes/wanted?start=0&length=${length}`,
      { headers }
    ),
  getProviders: () => fetchJson<{ data: any[] }>(`${url}/api/providers`, { headers }),
  getMovieDetails: async (radarrId: number) => {
    const res = await fetchJson<{ data: BazarrMovieDetails[] }>(
      `${url}/api/movies?radarrid%5B%5D=${radarrId}`,
      { headers }
    );
    return res.data[0] ?? null;
  },
  getEpisodesDetails: (seriesId: number) =>
    fetchJson<{ data: BazarrEpisodeDetails[] }>(`${url}/api/episodes?seriesid%5B%5D=${seriesId}`, {
      headers,
    }).then((res) => res.data),
  searchMovieSubtitles: (radarrId: number) =>
    fetchJson<{ data: BazarrSubtitleCandidate[] }>(
      `${url}/api/providers/movies?radarrid=${radarrId}`,
      { headers },
      30000
    ),
  searchEpisodeSubtitles: (episodeId: number) =>
    fetchJson<{ data: BazarrSubtitleCandidate[] }>(
      `${url}/api/providers/episodes?episodeid=${episodeId}`,
      { headers },
      30000
    ),
  downloadMovieSubtitle: (params: {
    radarrId: number;
    candidate: BazarrSubtitleCandidate;
  }) => {
    const body = new URLSearchParams({
      radarrid: String(params.radarrId),
      hi: params.candidate.hearing_impaired,
      forced: params.candidate.forced,
      original_format: params.candidate.original_format,
      provider: params.candidate.provider,
      subtitle: params.candidate.subtitle,
    });
    return fetch(`${url}/api/providers/movies`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  },
  downloadEpisodeSubtitle: (params: {
    seriesId: number;
    episodeId: number;
    candidate: BazarrSubtitleCandidate;
  }) => {
    const body = new URLSearchParams({
      seriesid: String(params.seriesId),
      episodeid: String(params.episodeId),
      hi: params.candidate.hearing_impaired,
      forced: params.candidate.forced,
      original_format: params.candidate.original_format,
      provider: params.candidate.provider,
      subtitle: params.candidate.subtitle,
    });
    return fetch(`${url}/api/providers/episodes`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  },
};
