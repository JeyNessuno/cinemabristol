fetch("./movies.json")
  .then(r => r.json())
  .then(data => {
    console.log("Loaded:", data);
  });