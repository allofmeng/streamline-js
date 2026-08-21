// settings-search.js — what the settings search box is allowed to match.
//
// The nav tree only knows page names, so a plugin's own vocabulary ("upload",
// "visualizer", "threshold") was unreachable: a user searching for a setting had
// to already know which page it lives on. GET /plugins carries each plugin's
// name, description and its manifest settings declarations, which is exactly
// that vocabulary — folded in here as extra keywords on the pages that host it.

// Manifest setting names are PascalCase identifiers ("AutoUpload",
// "LengthThreshold"). Searching for "upload" should find them, so index the split
// words alongside the raw name.
function splitIdentifier(name) {
    return String(name)
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ');
}

// One lowercase blob per plugin: name, description, and every setting's name and
// description. Blob rather than a structure because the search is a substring
// test, and a structure would only be flattened at the point of use.
export function pluginKeywords(plugin) {
    if (!plugin) return '';
    const parts = [plugin.name, plugin.description, plugin.id];
    for (const [key, declaration] of Object.entries(plugin.settings || {})) {
        parts.push(key, splitIdentifier(key), declaration?.description);
    }
    return parts.filter(Boolean).join(' ').toLowerCase();
}

export function pluginListKeywords(plugins) {
    return (plugins || []).map(pluginKeywords).filter(Boolean).join(' ');
}

// The one predicate both the filter pass and the render pass use, so a term that
// surfaces a category always finds the same rows inside it.
export function subcategoryMatches(subcat, searchTerm) {
    if (!searchTerm) return true;
    const term = searchTerm.toLowerCase();
    return (subcat.name || '').toLowerCase().includes(term)
        || (subcat.id || '').toLowerCase().includes(term)
        || (subcat.keywords || '').includes(term);
}
