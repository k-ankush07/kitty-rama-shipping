export function getElementByIdCompat(doc, id) {
  if (!doc) {
    return null;
  }

  if (typeof doc.getElementById === "function") {
    return doc.getElementById(id);
  }

  if (typeof doc.querySelector === "function") {
    const selector = `[id="${String(id).replace(/"/g, '\\"')}"]`;
    return doc.querySelector(selector);
  }

  return null;
}

export function showModalById(id, doc = document) {
  const element = getElementByIdCompat(doc, id);
  if (typeof element?.show === "function") {
    element.show();
    return true;
  }

  return false;
}

export function hideModalById(id, doc = document) {
  const element = getElementByIdCompat(doc, id);
  if (typeof element?.hide === "function") {
    element.hide();
    return true;
  }

  return false;
}
