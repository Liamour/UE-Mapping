import { ReactFlowProvider } from 'reactflow';
import { GraphCanvas } from './components/graph/GraphCanvas';
import { Sidebar } from './components/layout/Sidebar';
import './App.css';

function App() {

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-slate-950">
      <ReactFlowProvider>
        <GraphCanvas />
      </ReactFlowProvider>
      <Sidebar />
    </div>
  );
}

export default App;
