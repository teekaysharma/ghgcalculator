import { Switch, Route } from "wouter";
import NotFound from "@/pages/not-found";
import Home from "@/pages/Home";
import Footer from "./Footer"; // Import the Footer component

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <div>
      <Router />
      <Footer /> {/* Add the Footer at the bottom */}
    </div>
  );
}

export default App;
