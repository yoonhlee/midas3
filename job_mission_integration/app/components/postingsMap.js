/* 채용공고 지도: Leaflet + markercluster를 서버(/vendor)에서 필요할 때만 불러온다. */

const KOREA_BOUNDS = [[33.0, 124.6], [38.7, 131.0]];
const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

let leafletPromise = null;

function loadCss(href) {
  if (document.querySelector(`link[data-vendor="${href}"]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  link.dataset.vendor = href;
  document.head.appendChild(link);
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = false;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`스크립트를 불러오지 못했어: ${src}`));
    document.head.appendChild(script);
  });
}

// 한 번만 로드하는 Promise. 실패하면 다음 호출에서 다시 시도한다.
export function ensureLeaflet() {
  if (window.L && typeof window.L.markerClusterGroup === "function") return Promise.resolve(window.L);
  if (!leafletPromise) {
    leafletPromise = (async () => {
      loadCss("/vendor/leaflet/leaflet.css");
      loadCss("/vendor/leaflet.markercluster/MarkerCluster.css");
      loadCss("/vendor/leaflet.markercluster/MarkerCluster.Default.css");
      if (!window.L) await loadScript("/vendor/leaflet/leaflet.js");
      // markercluster(UMD)는 window.L이 생긴 다음에 불러야 한다.
      if (typeof window.L.markerClusterGroup !== "function") {
        await loadScript("/vendor/leaflet.markercluster/leaflet.markercluster.js");
      }
      return window.L;
    })().catch((error) => {
      leafletPromise = null;
      throw error;
    });
  }
  return leafletPromise;
}

// 같은 좌표(소수 5자리)의 공고는 마커 하나로 묶는다.
export function groupByCoordinate(items) {
  const groups = new Map();
  for (const item of items) {
    if (typeof item.lat !== "number" || typeof item.lng !== "number") continue;
    const key = `${item.lat.toFixed(5)},${item.lng.toFixed(5)}`;
    if (!groups.has(key)) groups.set(key, { lat: item.lat, lng: item.lng, items: [] });
    groups.get(key).items.push(item);
  }
  return [...groups.values()];
}

/**
 * @param {HTMLElement} container
 * @param {{ renderPopup: (items: any[]) => string }} options
 * @returns {Promise<{ setItems: (items: any[], opts?: { fit?: boolean }) => void, destroy: () => void } | null>}
 */
export async function createPostingsMap(container, { renderPopup }) {
  const L = await ensureLeaflet();
  // 로드하는 사이에 화면이 바뀌었으면 만들지 않는다.
  if (!container.isConnected) return null;

  const map = L.map(container, { scrollWheelZoom: false, zoomSnap: 0.5 });
  map.fitBounds(KOREA_BOUNDS);
  L.tileLayer(TILE_URL, { maxZoom: 18, attribution: TILE_ATTRIBUTION, className: "pst-tiles" }).addTo(map);
  const cluster = L.markerClusterGroup({ showCoverageOnHover: false, maxClusterRadius: 48, spiderfyOnMaxZoom: true });
  map.addLayer(cluster);

  function markerFor(group) {
    const exact = group.items.some((item) => item.geo_precision === "address");
    const count = group.items.length;
    const icon = L.divIcon({
      className: `pst-marker ${exact ? "pst-marker-exact" : "pst-marker-approx"}`,
      html: count > 1 ? `<span>${count}</span>` : "",
      iconSize: exact ? [18, 18] : [30, 30]
    });
    const first = group.items[0];
    const marker = L.marker([group.lat, group.lng], {
      icon,
      keyboard: true,
      title: count > 1 ? `${count}건의 공고` : `${first.company || "회사명 없음"} · ${first.title}`
    });
    marker.bindPopup(renderPopup(group.items), { maxWidth: 280, autoPanPadding: [16, 16] });
    return marker;
  }

  return {
    setItems(items, { fit = false } = {}) {
      cluster.clearLayers();
      const groups = groupByCoordinate(items);
      cluster.addLayers(groups.map(markerFor));
      if (!fit) return;
      if (!groups.length) {
        map.fitBounds(KOREA_BOUNDS);
        return;
      }
      const bounds = L.latLngBounds(groups.map((g) => [g.lat, g.lng]));
      map.fitBounds(bounds.pad(0.25), { maxZoom: 12 });
    },
    destroy() {
      map.remove();
    }
  };
}
