// Fetching a JSON dataset from public/data, two ways: required (throws, so
// the caller decides what a missing file means) and optional (null with a
// warning, so a dataset that has not been downloaded never fails the map).

export async function loadJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} responded ${response.status}`);
  }
  return response.json();
}

export async function loadJsonOrNull(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch (error) {
    console.warn(`Optional dataset unavailable (${url}):`, error);
    return null;
  }
}
