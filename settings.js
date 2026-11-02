const DEFAULT_SETTINGS = {
    saveZoomValues: true,
    invertScroll: true,
    nearestNeighbour: false,
    square: false,
    zoom: 2,
    size: 100,
    zoomSpeed: 0.5,
    delay: 200,
};

function debounce(func, delay = 100) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => func(...args), delay);
    };
}
