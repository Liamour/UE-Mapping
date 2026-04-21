import { Handle, Position } from 'reactflow'; 

export const BlueprintNode = ({ data }: any) => { 
  const inputs = data.pins?.filter((p: any) => p.direction === 'input') || []; 
  const outputs = data.pins?.filter((p: any) => p.direction === 'output') || []; 

  return ( 
    <div className="bg-[#111] border border-[#333] rounded-md shadow-2xl min-w-[200px] font-mono text-white overflow-hidden"> 
      {/* Node Header */} 
      <div className="bg-[#ff6600] px-3 py-1 border-b border-[#333]"> 
        <h3 className="text-black font-black text-xs uppercase tracking-widest">{data.label}</h3> 
      </div> 

      {/* Pins Area */} 
      <div className="flex justify-between p-2 gap-4"> 
        {/* Input Pins (Left) */} 
        <div className="flex flex-col gap-2"> 
          {inputs.map((pin: any) => ( 
            <div key={pin.pinId} className="relative flex items-center h-4"> 
              <Handle 
                type="target" 
                position={Position.Left} 
                id={pin.pinId} 
                className="w-2 h-2 !bg-[#aaa] !border-none !left-[-12px] rounded-sm" 
              /> 
              <span className="text-[9px] text-[#888] ml-1 uppercase">{pin.pinName}</span> 
            </div> 
          ))} 
        </div> 

        {/* Output Pins (Right) */} 
        <div className="flex flex-col gap-2 items-end"> 
          {outputs.map((pin: any) => ( 
            <div key={pin.pinId} className="relative flex items-center h-4"> 
              <span className="text-[9px] text-[#888] mr-1 uppercase">{pin.pinName}</span> 
              <Handle 
                type="source" 
                position={Position.Right} 
                id={pin.pinId} 
                className="w-2 h-2 !bg-[#ff6600] !border-none !right-[-12px] rounded-sm" 
              /> 
            </div> 
          ))} 
        </div> 
      </div> 
    </div> 
  ); 
};