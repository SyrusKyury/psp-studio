let currentFile = null;

window.tool = {
  async open(file) {
    currentFile = file;
    document.querySelector('#status').textContent = `Opened ${file.name}`;
  },

  get(id) {
    if (id === 'current') return currentFile;
    return null;
  }
};
