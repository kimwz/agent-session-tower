import { useId } from 'react';
import { SmoothStepEdge, type EdgeProps } from '@xyflow/react';

export function ProjectEdge(props: EdgeProps) {
  const gradientId = `project-activity-${useId()}`;
  return <>
    {props.animated && <defs>
      <linearGradient id={gradientId} gradientUnits="userSpaceOnUse" x1={props.sourceX} y1={props.sourceY} x2={props.targetX} y2={props.targetY}>
        <stop offset="0%" stopColor="#56edff" />
        <stop offset="22%" stopColor="#668bff" />
        <stop offset="44%" stopColor="#b17bff" />
        <stop offset="62%" stopColor="#ff87bc" />
        <stop offset="76%" stopColor="#b17bff" />
        <stop offset="100%" stopColor="#56edff" />
      </linearGradient>
    </defs>}
    <SmoothStepEdge {...props} style={props.animated ? { ...props.style, stroke: `url(#${gradientId}) #56edff`, strokeWidth: 2 } : props.style} />
  </>;
}
