import "./style.css";

const greetings = ["Hello, Hiraya.", "Mabuhay!", "Build something thoughtful."];
const heading = document.querySelector("h1");
const button = document.querySelector("button");
let greeting = 0;

button?.addEventListener("click", () => {
  greeting = (greeting + 1) % greetings.length;
  if (heading) heading.textContent = greetings[greeting];
});
