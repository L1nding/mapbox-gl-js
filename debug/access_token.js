'use strict';

mapboxgl.accessToken = getAccessToken();

function getAccessToken() {
    const accessToken = [
        process.env.MapboxAccessToken,
        process.env.MAPBOX_ACCESS_TOKEN,
        getURLParameter('access_token'),
        localStorage.getItem('accessToken'),
        // this token is a fallback for CI and testing. it is domain restricted to localhost
        'pk.eyJ1IjoicmFkb25uYW1lMTIzIiwiYSI6ImNseHd5NzZiMzI3YjEyaXEzcW9iM3R1a2QifQ.MByPH0cxVAarIdVup_6MOQ'
    ].find(Boolean);

    try {
        localStorage.setItem('accessToken', accessToken);
    } catch (_) {
        // no-op
    }
    return accessToken;
}

function getURLParameter(name) {
    const url = new URL(window.location.href);
    return url.searchParams.get(name);
}
