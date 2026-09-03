'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { cacheFeed, clearToken, fetchFeed, formatMoney, formatNumber, readCachedFeed, readToken, sendHeartbeat } from '@/lib/display-client';

const APP_VERSION = '1.0.0';
const BASE_POLL_MS = 12_000;
const MAX_POLL_MS = 120_000;
const HEARTBEAT_MS = 60_000;

export default function DisplayPage() {
  const router = useRouter();
  const [token, setToken] = useState(null);
  const [feed, setFeed] = useState(null);
  const [status, setStatus] = useState({ live: false, staleSince: null, message: 'Connecting…' });
  const [slideIndex, setSlideIndex] = useState(0);
  const [clock, setClock] = useState('');
  const etag = useRef(null);
  const backoff = useRef(BASE_POLL_MS);

  useEffect(() => {
    const stored = readToken();
    if (!stored) {
      router.replace('/pair');
      return;
    }
    setToken(stored);
    const cached = readCachedFeed();
    if (cached?.feed) {
      setFeed(cached.feed);
      setStatus({ live: false, staleSince: cached.cached_at, message: 'Showing the last received results' });
    }
  }, [router]);

  const poll = useCallback(async () => {
    if (!token) return;
    if (document.visibilityState === 'hidden') return;
    try {
      const result = await fetchFeed({ token, etag: etag.current });
      if (!result.unchanged) {
        setFeed(result.feed);
        etag.current = result.etag;
        cacheFeed(result.feed);
      }
      backoff.current = BASE_POLL_MS;
      setStatus({ live: true, staleSince: null, message: 'Live' });
    } catch (error) {
      if (error.revoked) {
        clearToken();
        router.replace('/pair');
        return;
      }
      backoff.current = Math.min(backoff.current * 2, MAX_POLL_MS);
      setStatus((current) => ({ live: false, staleSince: current.staleSince ?? Date.now(), message: 'Reconnecting…' }));
    }
  }, [token, router]);

  useEffect(() => {
    if (!token) return undefined;
    let timer;
    const tick = async () => {
      await poll();
      timer = setTimeout(tick, backoff.current);
    };
    tick();
    const onVisible = () => document.visibilityState === 'visible' && poll();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [token, poll]);

  useEffect(() => {
    if (!token) return undefined;
    sendHeartbeat({ token, appVersion: APP_VERSION });
    const timer = setInterval(() => sendHeartbeat({ token, appVersion: APP_VERSION }), HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [token]);

  useEffect(() => {
    const tick = () =>
      setClock(new Intl.DateTimeFormat('en-AE', { hour: '2-digit', minute: '2-digit', timeZone: feed?.organization?.timezone ?? 'Asia/Dubai' }).format(new Date()));
    tick();
    const timer = setInterval(tick, 15_000);
    return () => clearInterval(timer);
  }, [feed?.organization?.timezone]);

  useEffect(() => {
    if ('serviceWorker' in navigator && process.env.NODE_ENV === 'production') {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }, []);

  useEffect(() => {
    if (feed?.display?.theme) document.documentElement.dataset.theme = feed.display.theme;
    if (feed?.branding?.primary_color) document.documentElement.style.setProperty('--brand', feed.branding.primary_color);
    if (feed?.branding?.accent_color) document.documentElement.style.setProperty('--accent', feed.branding.accent_color);
  }, [feed?.display?.theme, feed?.branding?.primary_color, feed?.branding?.accent_color]);

  const slides = useMemo(() => buildSlides(feed), [feed]);

  useEffect(() => {
    if (slides.length === 0) return undefined;
    const duration = (slides[slideIndex]?.duration_seconds ?? feed?.display?.slide_duration_seconds ?? 15) * 1000;
    const timer = setTimeout(() => setSlideIndex((index) => (index + 1) % slides.length), duration);
    return () => clearTimeout(timer);
  }, [slideIndex, slides, feed?.display?.slide_duration_seconds]);

  useEffect(() => {
    if (slideIndex >= slides.length) setSlideIndex(0);
  }, [slides.length, slideIndex]);

  if (!feed) {
    return (
      <main className="screen">
        <div />
        <div className="slide" style={{ textAlign: 'center' }}>
          <p className="slide__sub">{status.message}</p>
        </div>
        <div />
      </main>
    );
  }

  const slide = slides[slideIndex] ?? slides[0];
  const currency = feed.organization?.currency ?? 'AED';
  const staleMinutes = status.staleSince ? Math.round((Date.now() - status.staleSince) / 60_000) : 0;

  return (
    <main className="screen">
      <header className="screen__head">
        <div className="screen__brand">
          {feed.branding?.logo_light_url ? (
            // A plain img keeps tenant logo URLs working without image-optimizer config.
            <img className="screen__logo" src={feed.branding.logo_light_url} alt="" />
          ) : null}
          <span className="screen__org">{feed.branding?.company_display_name ?? feed.organization?.name}</span>
        </div>
        <div className="screen__meta">
          <div className="screen__clock">{clock}</div>
          <span className={`state-pill ${status.live ? 'state-pill--live' : 'state-pill--stale'}`}>
            <span className="state-pill__dot" />
            {status.live ? 'Live' : staleMinutes > 0 ? `Last updated ${staleMinutes} min ago` : status.message}
          </span>
        </div>
      </header>

      <Slide slide={slide} feed={feed} currency={currency} />

      <footer className="ticker">
        <span>{feed.display?.name}</span>
        <div className="dots" aria-hidden="true">
          {slides.map((entry, index) => (
            <span key={entry.key} className={`dot${index === slideIndex ? ' is-active' : ''}`} />
          ))}
        </div>
        <span>{slide?.title}</span>
      </footer>
    </main>
  );
}

/** Turns the configured playlist into renderable slides, skipping ones with no data. */
function buildSlides(feed) {
  if (!feed) return [];
  const configured = feed.slides?.length ? feed.slides : [{ id: 'default', type: 'total_revenue', title: 'Revenue' }];

  return configured
    .map((slide) => ({ ...slide, key: slide.id ?? slide.type }))
    .filter((slide) => {
      switch (slide.type) {
        case 'new_deal_celebration':
          return (feed.events ?? []).some((event) => event.type === 'deal_won');
        case 'new_listing':
          return (feed.events ?? []).some((event) => event.type === 'listing_published');
        case 'top_agents':
          return (feed.top_agents ?? []).length > 0;
        case 'top_teams':
          return (feed.top_teams ?? []).length > 0;
        case 'top_deals':
          return (feed.top_deals ?? []).length > 0;
        case 'points_leaderboard':
          return (feed.points_leaderboard ?? []).length > 0;
        case 'target_progress':
          return Boolean(feed.metrics?.target);
        case 'announcements':
          return (feed.announcements ?? []).length > 0;
        case 'stock_summary':
          return (feed.metrics?.stock ?? []).length > 0;
        default:
          return true;
      }
    });
}

function Slide({ slide, feed, currency }) {
  if (!slide) return <div className="slide" />;
  const metrics = feed.metrics ?? {};

  switch (slide.type) {
    case 'new_deal_celebration': {
      const event = (feed.events ?? []).find((entry) => entry.type === 'deal_won');
      return (
        <section className="slide celebration">
          <span className="celebration__badge">Deal closed</span>
          <div className="slide__hero">{event?.amount != null ? formatMoney(event.amount, event.currency ?? currency) : 'Congratulations'}</div>
          <p className="slide__sub">
            {event?.payload?.agent_name ?? 'Our team'} · {event?.payload?.reference ?? ''}
          </p>
        </section>
      );
    }

    case 'new_listing': {
      const event = (feed.events ?? []).find((entry) => entry.type === 'listing_published');
      return (
        <section className="slide celebration">
          <span className="celebration__badge">{event?.payload?.is_exclusive ? 'New exclusive listing' : 'New listing live'}</span>
          <div className="slide__hero" style={{ fontSize: 'clamp(32px, 5vw, 84px)' }}>{event?.payload?.title ?? 'New listing published'}</div>
          <p className="slide__sub">{event?.amount != null ? formatMoney(event.amount, currency) : ''}</p>
        </section>
      );
    }

    case 'top_agents':
    case 'top_teams': {
      const rows = slide.type === 'top_agents' ? feed.top_agents : feed.top_teams;
      return (
        <section className="slide">
          <h2 className="slide__title">{slide.title ?? (slide.type === 'top_agents' ? 'Top agents' : 'Top teams')}</h2>
          <div className="leaderboard">
            {rows.slice(0, 6).map((row, index) => (
              <div key={row.membership_id ?? row.team_id ?? index} className="leaderboard__row">
                <span className="leaderboard__rank">{index + 1}</span>
                <span>{row.name ?? 'Team'}</span>
                <span className="leaderboard__value">{row.revenue != null ? formatMoney(row.revenue, currency) : `${row.deals} deals`}</span>
              </div>
            ))}
          </div>
        </section>
      );
    }

    case 'top_deals':
      return (
        <section className="slide">
          <h2 className="slide__title">{slide.title ?? 'Top deals'}</h2>
          <div className="leaderboard">
            {feed.top_deals.map((deal, index) => (
              <div key={deal.reference} className="leaderboard__row">
                <span className="leaderboard__rank">{index + 1}</span>
                <span>{deal.agent_name ?? 'Team'}</span>
                <span className="leaderboard__value">{formatMoney(deal.property_value, deal.currency ?? currency)}</span>
              </div>
            ))}
          </div>
        </section>
      );

    case 'points_leaderboard':
      return (
        <section className="slide">
          <h2 className="slide__title">{slide.title ?? 'Points leaderboard'}</h2>
          <div className="leaderboard">
            {feed.points_leaderboard.map((row) => (
              <div key={row.membership_id} className="leaderboard__row">
                <span className="leaderboard__rank">{row.rank}</span>
                <span>{row.name ?? 'Agent'}</span>
                <span className="leaderboard__value">{formatNumber(row.points)} pts</span>
              </div>
            ))}
          </div>
        </section>
      );

    case 'target_progress': {
      const target = metrics.target;
      return (
        <section className="slide">
          <h2 className="slide__title">{slide.title ?? 'Target progress'}</h2>
          <div className="slide__hero">{target.percentage}%</div>
          <div className="progress">
            <span className="progress__fill" style={{ width: `${Math.min(target.percentage, 100)}%` }} />
          </div>
          <p className="slide__sub">
            {formatMoney(target.achieved, currency)} of {formatMoney(target.value, currency)}
          </p>
        </section>
      );
    }

    case 'stock_summary':
      return (
        <section className="slide">
          <h2 className="slide__title">{slide.title ?? 'Off-plan stock'}</h2>
          <div className="tiles">
            {metrics.stock.map((row) => (
              <div key={row.status} className="tile">
                <span className="tile__label">{row.status.replace(/_/g, ' ')}</span>
                <span className="tile__value">{formatNumber(row.count)}</span>
              </div>
            ))}
          </div>
        </section>
      );

    case 'announcements': {
      const announcement = feed.announcements[0];
      return (
        <section className="slide celebration">
          <span className="celebration__badge">Announcement</span>
          <div className="slide__hero" style={{ fontSize: 'clamp(30px, 4.5vw, 76px)' }}>{announcement.title}</div>
          {announcement.body ? <p className="slide__sub">{announcement.body}</p> : null}
        </section>
      );
    }

    case 'deal_count':
    case 'listing_count':
    case 'offplan_reservations':
    case 'total_revenue':
    default:
      return (
        <section className="slide">
          <h2 className="slide__title">{slide.title ?? 'Performance'}</h2>
          <div className="tiles">
            <div className="tile">
              <span className="tile__label">Revenue</span>
              <span className="tile__value">{metrics.revenue != null ? formatMoney(metrics.revenue, currency) : '—'}</span>
            </div>
            <div className="tile">
              <span className="tile__label">Deals won</span>
              <span className="tile__value">{formatNumber(metrics.deal_count)}</span>
            </div>
            <div className="tile">
              <span className="tile__label">Listings live</span>
              <span className="tile__value">{formatNumber(metrics.listing_count)}</span>
            </div>
            <div className="tile">
              <span className="tile__label">Reservations</span>
              <span className="tile__value">{formatNumber(metrics.active_reservations)}</span>
            </div>
          </div>
        </section>
      );
  }
}
