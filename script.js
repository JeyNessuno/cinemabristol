fetch("./movies.enriched.json")
  .then(r => r.json())
  .then(data => {
    console.log("Loaded:", data);
  });